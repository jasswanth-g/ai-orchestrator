import { backlogTools } from './backlog.ts';
import { briefTools } from './brief.ts';
import { captureTools } from './capture.ts';
import type { ToolDef } from './define.ts';
import { fileTools } from './files.ts';
import { memoryTools } from './memory.ts';
import { planTools } from './plan.ts';
import { questionTools } from './questions.ts';
import { reportTools } from './reports.ts';
import { taskTools } from './tasks.ts';

/** Every tool the server exposes. Add a group here and it's registered. */
export const ALL_TOOLS: ToolDef[] = [
  ...taskTools,
  ...backlogTools,
  ...planTools,
  ...questionTools,
  ...memoryTools,
  ...captureTools,
  ...fileTools,
  ...briefTools,
  ...reportTools,
] as ToolDef[];
