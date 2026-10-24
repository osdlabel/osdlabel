/**
 * Linux-only process memory sampler for a Chromium tree: sums RSS and PSS
 * (from /proc/<pid>/smaps_rollup) per Chromium process type, so a benchmark
 * can attribute memory to the renderer (JS heap, SharedArrayBuffers, canvas
 * backing stores) versus the GPU process (with SwiftShader, every WebGL
 * texture lives there, in CPU RAM). Returns null off Linux.
 */
import fs from 'node:fs';

function typeOf(pid) {
  try {
    // Chromium rewrites its argv into one space-separated string (setproctitle).
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/);
    const t = cmd.find((a) => a.startsWith('--type='));
    if (!t) return 'browser';
    const type = t.slice(7);
    if (type === 'utility') {
      const sub = cmd.find((a) => a.startsWith('--utility-sub-type='));
      return sub ? `utility:${sub.split('.').pop()}` : 'utility';
    }
    return type;
  } catch {
    return null;
  }
}

function rollup(pid) {
  try {
    const txt = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kb = (key) => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
      return m ? Number(m[1]) * 1024 : 0;
    };
    return { rss: kb('Rss'), pss: kb('Pss') };
  } catch {
    return null;
  }
}

export function sampleProcessMemory(rootPid) {
  if (process.platform !== 'linux' || !rootPid) return null;
  // Parent map from /proc/*/stat (field 4 is the ppid; the comm field may
  // contain spaces, so parse after its closing parenthesis).
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch {
      // exited
    }
  }
  const seen = new Set();
  const stack = [rootPid];
  const byType = {};
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...(kids.get(pid) ?? []));
    const type = typeOf(pid);
    const mem = rollup(pid);
    if (!type || !mem) continue;
    const slot = (byType[type] ??= { count: 0, rss: 0, pss: 0 });
    slot.count++;
    slot.rss += mem.rss;
    slot.pss += mem.pss;
  }
  return byType;
}

/** PID of the process whose command line contains `marker` (a flag we passed). */
export function findPidByMarker(marker) {
  if (process.platform !== 'linux') return null;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (cmd.includes(marker) && !cmd.includes('--type=')) return Number(d);
    } catch {
      // process exited
    }
  }
  return null;
}

export const MiB = (b) =>
  b === null || b === undefined ? null : Math.round((b / 1048576) * 10) / 10;
