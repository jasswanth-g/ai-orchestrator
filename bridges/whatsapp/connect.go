package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/mdp/qrterminal"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"rsc.io/qr"
)

// Connection state and pairing, exposed on the REST API so a UI can show the
// QR code and the link status instead of the terminal:
//
//	GET  /api/status   {state, account, push_name, qr_age_s, error}
//	GET  /api/qr.png   current pairing QR (404 when there is none)
//	POST /api/pair     new QR after the last one expired (restarts the bridge)
//	POST /api/logout   unlink this device (restarts the bridge, ready to pair)
//
// "Restart" = exit 0; the agents server restarts the bridge straight away, and
// a fresh process with no device in the store starts pairing.

type connState struct {
	mu       sync.Mutex
	State    string // starting | pairing | qr_expired | connecting | connected | logged_out | error
	QR       string
	QRAt     time.Time
	Account  string
	PushName string
	Err      string
}

var conn = &connState{State: "starting"}

func (c *connState) set(f func(*connState)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	f(c)
}

// connectOrPair connects a linked device, or runs QR pairing for a new one.
func connectOrPair(client *whatsmeow.Client, logger waLog.Logger) {
	if client.Store.ID != nil {
		conn.set(func(c *connState) { c.State = "connecting" })
		if err := client.Connect(); err != nil {
			conn.set(func(c *connState) { c.State, c.Err = "error", err.Error() })
			logger.Errorf("Failed to connect: %v", err)
		}
		return
	}

	qrChan, _ := client.GetQRChannel(context.Background())
	if err := client.Connect(); err != nil {
		conn.set(func(c *connState) { c.State, c.Err = "error", err.Error() })
		logger.Errorf("Failed to connect: %v", err)
		return
	}
	for evt := range qrChan {
		switch evt.Event {
		case "code":
			conn.set(func(c *connState) { c.State, c.QR, c.QRAt, c.Err = "pairing", evt.Code, time.Now(), "" })
			fmt.Println("\nScan this QR code with WhatsApp (or open the agents UI):")
			qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
		case "success":
			conn.set(func(c *connState) { c.State, c.QR = "connecting", "" })
			fmt.Println("\nSuccessfully paired!")
		case "timeout":
			conn.set(func(c *connState) { c.State, c.QR = "qr_expired", "" })
			logger.Warnf("QR code expired; request a new one from the UI")
		default:
			conn.set(func(c *connState) { c.State, c.QR, c.Err = "error", "", evt.Event })
		}
	}
}

// trackConnection keeps the state in step with whatsmeow's connection events.
func trackConnection(client *whatsmeow.Client, evt interface{}) {
	switch evt.(type) {
	case *events.Connected:
		conn.set(func(c *connState) {
			c.State, c.Err = "connected", ""
			if client.Store.ID != nil {
				c.Account = client.Store.ID.User
			}
			c.PushName = client.Store.PushName
		})
	case *events.Disconnected:
		conn.set(func(c *connState) {
			if c.State == "connected" {
				c.State = "connecting"
			}
		})
	case *events.LoggedOut:
		// whatsmeow has already deleted the device; a fresh process starts pairing.
		conn.set(func(c *connState) { c.State = "logged_out" })
		restartSoon()
	}
}

func restartSoon() {
	go func() {
		time.Sleep(500 * time.Millisecond)
		os.Exit(0)
	}()
}

// callerAllowed blocks cross-site requests from a browser: with
// WHATSAPP_EVENT_SECRET set (the agents server sets it) callers must send it
// as X-Bridge-Secret; without it, a JSON content type forces a CORS preflight.
func callerAllowed(w http.ResponseWriter, r *http.Request) bool {
	ok := r.Header.Get("Content-Type") == "application/json"
	if secret := os.Getenv("WHATSAPP_EVENT_SECRET"); secret != "" {
		ok = subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Bridge-Secret")), []byte(secret)) == 1
	}
	if !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
	}
	return ok
}

func registerConnectionAPI(client *whatsmeow.Client) {
	http.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		if !callerAllowed(w, r) {
			return
		}
		conn.mu.Lock()
		out := map[string]any{"state": conn.State, "account": conn.Account, "push_name": conn.PushName, "error": conn.Err}
		if conn.QR != "" {
			out["qr_age_s"] = int(time.Since(conn.QRAt).Seconds())
		}
		conn.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(out)
	})

	http.HandleFunc("/api/qr.png", func(w http.ResponseWriter, r *http.Request) {
		if !callerAllowed(w, r) {
			return
		}
		conn.mu.Lock()
		code := conn.QR
		conn.mu.Unlock()
		if code == "" {
			http.Error(w, "no QR code", http.StatusNotFound)
			return
		}
		img, err := qr.Encode(code, qr.L)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		img.Scale = 8
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(img.PNG())
	})

	http.HandleFunc("/api/pair", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !callerAllowed(w, r) {
			return
		}
		if client.Store.ID != nil {
			http.Error(w, "already linked", http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		restartSoon()
	})

	http.HandleFunc("/api/logout", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !callerAllowed(w, r) {
			return
		}
		if err := client.Logout(context.Background()); err != nil {
			// Unlinked on our side regardless, so the next start pairs fresh.
			client.Disconnect()
			_ = client.Store.Delete(context.Background())
		}
		conn.set(func(c *connState) { c.State = "logged_out" })
		w.WriteHeader(http.StatusAccepted)
		restartSoon()
	})
}
