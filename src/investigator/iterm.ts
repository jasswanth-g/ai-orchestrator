/**
 * iTerm2 control through AppleScript: open a window running a command, find a
 * session again by its unique id, bring it forward, or type into it. Each
 * investigation's terminal is one iTerm session.
 */

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function osascript(script: string): string {
  const r = Bun.spawnSync(['osascript', '-e', script], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`osascript: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** Opens a new iTerm window, runs `command` in its shell, returns the session's unique id. */
export function openWindow(command: string): string {
  return osascript(`tell application "iTerm"
  activate
  set w to (create window with default profile)
  tell current session of w
    write text ${quote(command)}
    return unique id
  end tell
end tell`);
}

/** AppleScript that runs `action` on the session with this id; returns "yes" if found. */
const withSession = (id: string, action: string) => `tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique id of s is ${quote(id)} then
          ${action}
          return "yes"
        end if
      end repeat
    end repeat
  end repeat
  return "no"
end tell`;

export function sessionAlive(id: string): boolean {
  try {
    return osascript(withSession(id, '')) === 'yes';
  } catch {
    return false;
  }
}

/** Brings the session's window to the front. */
export function focus(id: string): boolean {
  return osascript(withSession(id, 'select t\n          select w\n          activate')) === 'yes';
}

/** Types one line into the session, as if the developer typed it and pressed Enter. */
export function type(id: string, line: string): boolean {
  return osascript(withSession(id, `tell s to write text ${quote(line.replace(/\s*\n\s*/g, ' '))}`)) === 'yes';
}
