#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { filesRoot, localToday, log, pickStore, reportsPath } from './config.ts';
import { ReportsDb } from './store/reports.ts';
import { buildServer } from './server.ts';
import { ALL_TOOLS } from './tools/index.ts';

const store = pickStore();
if (!filesRoot) log('TODO_BRAIN_FILES_ROOT not set: relative paths resolve against the current directory');

// TODO_BRAIN_ONLY=a,b limits the server to those tools — e.g. the Investigator's reports-only server.
const only = (process.env.TODO_BRAIN_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const tools = only.length ? ALL_TOOLS.filter((t) => only.includes(t.name)) : ALL_TOOLS;
const server = buildServer({ store, filesRoot, today: localToday, exists: existsSync, reports: new ReportsDb(reportsPath()) }, tools);
await server.connect(new StdioServerTransport());
log(`ready — ${tools.length} tools${filesRoot ? `, files root ${filesRoot}` : ''}`);
