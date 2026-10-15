package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// Forwards each live message to an external event receiver (the agent
// orchestrator), so it can react without polling messages.db.
//
//	WHATSAPP_EVENT_URL     receiver, e.g. http://127.0.0.1:4321/hooks/whatsapp (unset = off)
//	WHATSAPP_EVENT_SECRET  sent as "Authorization: Bearer <secret>"
//	WHATSAPP_WATCH_CHATS   comma list of chat JIDs or exact chat names; empty = every chat
//
// Delivery is best effort with a few retries: every message is already in
// messages.db, so the receiver catches up from there after an outage.

type ForwardedMessage struct {
	ID            string   `json:"id"`
	ChatJID       string   `json:"chat_jid"`
	ChatName      string   `json:"chat_name"`
	IsGroup       bool     `json:"is_group"`
	Sender        string   `json:"sender"`
	SenderName    string   `json:"sender_name"`
	IsFromMe      bool     `json:"is_from_me"`
	Content       string   `json:"content"`
	MediaType     string   `json:"media_type,omitempty"`
	Filename      string   `json:"filename,omitempty"`
	Timestamp     string   `json:"timestamp"`
	MentionedJIDs []string `json:"mentioned_jids,omitempty"`
	ReplyToID     string   `json:"reply_to_id,omitempty"`
	ReplyToSender string   `json:"reply_to_sender,omitempty"`
	ReplyToText   string   `json:"reply_to_text,omitempty"`
	// My own ids (phone number user and LID user), so the receiver can tell "me" apart.
	Me []string `json:"me"`
}

type forwarder struct {
	url    string
	secret string
	watch  map[string]bool
	http   *http.Client
	logger waLog.Logger
}

func newForwarder(logger waLog.Logger) *forwarder {
	url := os.Getenv("WHATSAPP_EVENT_URL")
	if url == "" {
		return nil
	}
	watch := map[string]bool{}
	for _, c := range strings.Split(os.Getenv("WHATSAPP_WATCH_CHATS"), ",") {
		if c = strings.TrimSpace(c); c != "" {
			watch[c] = true
		}
	}
	logger.Infof("Forwarding messages to %s (%d watched chats, 0 = all)", url, len(watch))
	return &forwarder{url: url, secret: os.Getenv("WHATSAPP_EVENT_SECRET"), watch: watch, http: &http.Client{Timeout: 10 * time.Second}, logger: logger}
}

func (f *forwarder) watches(chatJID, chatName string) bool {
	return len(f.watch) == 0 || f.watch[chatJID] || f.watch[chatName]
}

// contextInfo carries mentions and the quoted message, wherever the message type keeps it.
func contextInfo(m *waProto.Message) *waProto.ContextInfo {
	switch {
	case m == nil:
		return nil
	case m.GetExtendedTextMessage() != nil:
		return m.GetExtendedTextMessage().GetContextInfo()
	case m.GetImageMessage() != nil:
		return m.GetImageMessage().GetContextInfo()
	case m.GetVideoMessage() != nil:
		return m.GetVideoMessage().GetContextInfo()
	case m.GetDocumentMessage() != nil:
		return m.GetDocumentMessage().GetContextInfo()
	case m.GetAudioMessage() != nil:
		return m.GetAudioMessage().GetContextInfo()
	}
	return nil
}

func (f *forwarder) forward(client *whatsmeow.Client, msg *events.Message, chatName, content, mediaType, filename string) {
	if f == nil || !f.watches(msg.Info.Chat.String(), chatName) {
		return
	}
	out := ForwardedMessage{
		ID:         msg.Info.ID,
		ChatJID:    msg.Info.Chat.String(),
		ChatName:   chatName,
		IsGroup:    msg.Info.IsGroup,
		Sender:     msg.Info.Sender.User,
		SenderName: msg.Info.PushName,
		IsFromMe:   msg.Info.IsFromMe,
		Content:    content,
		MediaType:  mediaType,
		Filename:   filename,
		Timestamp:  msg.Info.Timestamp.Format(time.RFC3339),
	}
	if ci := contextInfo(msg.Message); ci != nil {
		out.MentionedJIDs = ci.GetMentionedJID()
		out.ReplyToID = ci.GetStanzaID()
		out.ReplyToSender = ci.GetParticipant()
		out.ReplyToText = extractTextContent(ci.GetQuotedMessage())
	}
	if client.Store.ID != nil {
		out.Me = append(out.Me, client.Store.ID.User)
	}
	if !client.Store.LID.IsEmpty() {
		out.Me = append(out.Me, client.Store.LID.User)
	}
	go f.post(out)
}

func (f *forwarder) post(m ForwardedMessage) {
	body, _ := json.Marshal(m)
	for attempt := 1; attempt <= 3; attempt++ {
		req, _ := http.NewRequest(http.MethodPost, f.url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if f.secret != "" {
			req.Header.Set("Authorization", "Bearer "+f.secret)
		}
		res, err := f.http.Do(req)
		if err == nil {
			res.Body.Close()
			if res.StatusCode < 300 {
				return
			}
			if res.StatusCode < 500 {
				f.logger.Warnf("Event receiver rejected %s: %d", m.ID, res.StatusCode)
				return
			}
		}
		time.Sleep(time.Duration(attempt*2) * time.Second)
	}
	f.logger.Warnf("Could not forward %s to %s; the receiver will catch up from messages.db", m.ID, f.url)
}
