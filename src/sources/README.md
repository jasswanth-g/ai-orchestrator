# sources/ — direct channel pulls (v2 seam, empty in v1)

In v1, channels need **no code here**. Claude is the hub: it reads a mail /
WhatsApp / Teams message through that channel's own MCP server and calls
`capture(...)` on todo-brain. Install a new channel's MCP server and it works.

Add a module here only when a channel must be pulled *without* Claude in the
loop — e.g. a scheduled job that turns flagged Outlook mails into tasks. Shape:

```ts
export interface SourceAdapter {
  name: string;                                   // becomes the item's `source`
  pull(): Promise<Array<{ kind: Kind } & NewItem>>; // new items since last pull
}
```

Each pulled item goes through the same `Store.create` path as `capture`, so
`source` / `link` tracking stays identical.
