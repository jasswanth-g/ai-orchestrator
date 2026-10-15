#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { filesRoot, localToday, log, pickStore } from './config.ts';
import { buildServer } from './server.ts';
import { ALL_TOOLS } from './tools/index.ts';

const store = pickStore();
if (!filesRoot) log('TODO_BRAIN_FILES_ROOT not set: relative paths resolve against the current directory');

const server = buildServer({ store, filesRoot, today: localToday, exists: existsSync }, ALL_TOOLS);
await server.connect(new StdioServerTransport());
log(`ready — ${ALL_TOOLS.length} tools${filesRoot ? `, files root ${filesRoot}` : ''}`);
