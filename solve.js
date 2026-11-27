// diff-speed-01: a faster drop-in for makefun-diff 1.0.0.
//
// The rule this implements is make.fun's own (see the house baseline's
// vendor/makefun-diff/index.js header): lines cut after every "\n", common
// prefix then common suffix kept, then Myers's greedy search between them
// with make.fun's tie-break (a deletion wins when deletion and insertion
// reach the same point into the old text; no edge-diagonal pruning), and the
// patch format makefun-diff/1 with 3 lines of context per hunk.
//
// Speed comes from keeping the search integer-tight:
//   - every distinct line is interned once to a small integer id, so the
//     snake walk compares ints instead of re-comparing strings;
//   - the whole V history lives in one flat Int32Array (layer d starts at
//     d*d, diagonal k at offset k+d), grown geometrically and never
//     reallocated per depth, so the forward pass allocates nothing after
//     its first buffer;
//   - the inner loop picks its candidate with two selects and no explicit
//     "no path" test (NONE is -2, so a missing path folds into the same
//     arithmetic: a deletion from it reads -1, an insertion from it reads
//     -2 or -1, both below any real x), and handles the two edge diagonals
//     outside it, so the middle diagonals need no bounds checks at all.
//
// Nothing is cached from one case to the next: run() builds every
// structure it needs from its own input and throws it away.

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** No path reached this diagonal at this depth. */
const NONE = -2;

/**
 * A text's lines, each with its "\n" (the last one without, when the text
 * does not end in one). The empty text has no lines; "\n" has one, an
 * empty line.
 */
function tokenize(text) {
  const parts = text.split('\n');
  const lines = new Array(parts.length - 1);
  for (let i = 0; i < parts.length - 1; i++) lines[i] = parts[i] + '\n';
  if (parts[parts.length - 1] !== '') lines.push(parts[parts.length - 1]);
  return lines;
}

/**
 * Myers's search over a (length N) and b (length M), as integer line ids.
 * Returns { hist, D, kEnd }: hist is one flat Int32Array holding every
 * depth's V layer (layer d starts at d*d, diagonal k at d*d + k + d,
 * holding the x reached after the snake, NONE when no path reached that
 * diagonal); D is the first depth that reaches both ends and kEnd = N - M
 * its diagonal.
 */
function myersForward(a, b, N, M) {
  // The history buffer, grown geometrically; new room starts as NONE.
  let cap = 1 << 20;
  let hist = new Int32Array(cap);
  hist.fill(NONE);
  // Depth 0: the snake from (0, 0).
  let x = 0;
  let y = 0;
  while (x < N && y < M && a[x] === b[y]) {
    x++;
    y++;
  }
  hist[0] = x;
  if (x === N && y === M) return { hist, D: 0, kEnd: 0 };

  const maxEdit = N + M;
  for (let d = 1; d <= maxEdit; d++) {
    const need = d * d + 2 * d + 1;
    if (need > cap) {
      let next = cap;
      while (next < need) next *= 2;
      const grown = new Int32Array(next);
      grown.set(hist);
      grown.fill(NONE, cap);
      hist = grown;
      cap = next;
    }
    const H = hist;
    const base = d * d;
    const prevBase = (d - 1) * (d - 1);
    // Diagonal k = -d: only the insertion candidate exists (from k+1).
    {
      const addX = H[prevBase];
      if (addX >= 0 && addX + d <= M) {
        let x0 = addX;
        let y0 = x0 + d;
        while (x0 < N && y0 < M && a[x0] === b[y0]) {
          x0++;
          y0++;
        }
        H[base] = x0;
        if (x0 === N && y0 === M) return { hist, D: d, kEnd: -d };
      }
    }
    // Middle diagonals: both candidates exist (their values may be NONE).
    let ri = prevBase;
    let ai = prevBase + 2;
    let wi = base + 2;
    for (let k = -d + 2; k <= d - 2; k += 2, ri += 2, ai += 2, wi += 2) {
      const removeX = H[ri];
      const addX = H[ai];
      // A move past the end of either text is no candidate; NONE folds in:
      // a deletion from it reads -1, an insertion from it -2 or -1.
      const delX = removeX < N ? removeX + 1 : -1;
      const insX = addX - k <= M ? addX : -1;
      // The candidate further into the old text wins; the deletion wins
      // when both reach the same point.
      let x0 = delX >= insX ? delX : insX;
      if (x0 < 0) continue;
      let y0 = x0 - k;
      // Follow every run of lines equal in both as far as it goes.
      while (x0 < N && y0 < M && a[x0] === b[y0]) {
        x0++;
        y0++;
      }
      H[wi] = x0;
      if (x0 === N && y0 === M) return { hist, D: d, kEnd: k };
    }
    // Diagonal k = d: only the deletion candidate exists (from k-1).
    {
      const removeX = H[prevBase + 2 * d - 2];
      if (removeX >= 0 && removeX < N) {
        let x0 = removeX + 1;
        let y0 = x0 - d;
        while (x0 < N && y0 < M && a[x0] === b[y0]) {
          x0++;
          y0++;
        }
        H[base + 2 * d] = x0;
        if (x0 === N && y0 === M) return { hist, D: d, kEnd: d };
      }
    }
  }
  throw new Error('makefun-diff: the search ended without reaching both ends');
}

/**
 * The edit script of the middle slices, as segments { kind, count } in
 * order, recovered by backtracking the V history with the same tie-break
 * the forward pass used. kind is KEEP, DELETE or INSERT.
 */
function myersBacktrack(hist, N, M, D, kEnd) {
  const segments = [];
  let k = kEnd;
  let x = N;
  for (let d = D; d >= 1; d--) {
    const prevBase = (d - 1) * (d - 1);
    const prevWidth = 2 * (d - 1) + 1;
    const ri = prevBase + (k - 1) + (d - 1);
    const ai = prevBase + (k + 1) + (d - 1);
    const removeX = ri >= prevBase && ri < prevBase + prevWidth ? hist[ri] : NONE;
    const addX = ai >= prevBase && ai < prevBase + prevWidth ? hist[ai] : NONE;
    const canRemove = removeX >= 0 && removeX < N;
    const canAdd = addX >= 0 && addX - k <= M;
    let del;
    let xPre;
    if (canRemove && (!canAdd || removeX + 1 >= addX)) {
      del = true;
      xPre = removeX + 1;
    } else {
      del = false;
      xPre = addX;
    }
    // The snake this depth's path walked after its one edit.
    const snake = x - xPre;
    if (snake > 0) segments.push({ kind: KEEP, count: snake });
    segments.push({ kind: del ? DELETE : INSERT, count: 1 });
    // Step back to the end of depth d - 1's snake.
    k = del ? k - 1 : k + 1;
    x = hist[prevBase + k + (d - 1)];
  }
  // Depth 0's snake from (0, 0).
  if (x > 0) segments.push({ kind: KEEP, count: x });
  segments.reverse();
  return segments;
}

/** make.fun's own patch of input.old into input.new. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const aLines = tokenize(input.old);
  const bLines = tokenize(input.new);
  const n = aLines.length;
  const m = bLines.length;

  // Intern every distinct line once, so the search compares integers.
  const ids = new Map();
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let id = ids.get(aLines[i]);
    if (id === undefined) {
      id = ids.size;
      ids.set(aLines[i], id);
    }
    a[i] = id;
  }
  const b = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    let id = ids.get(bLines[i]);
    if (id === undefined) {
      id = ids.size;
      ids.set(bLines[i], id);
    }
    b[i] = id;
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  // The edit script of the middle slices.
  const midN = n - prefix - suffix;
  const midM = m - prefix - suffix;
  const mid = myersForward(a.subarray(prefix, n - suffix), b.subarray(prefix, m - suffix), midN, midM);
  const segments = myersBacktrack(mid.hist, midN, midM, mid.D, mid.kEnd);

  // The runs: prefix kept, the middle's segments, suffix kept, merged.
  const runs = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  };
  pushRun(KEEP, prefix);
  for (const s of segments) pushRun(s.kind, s.count);
  pushRun(KEEP, suffix);

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) {
        const line = aLines[at];
        if (line.endsWith('\n')) out.push('=', line);
        else out.push('=', line, '\n%\n');
      }
      for (let i = 0; i < c.dels; i++) {
        const line = aLines[c.o + i];
        if (line.endsWith('\n')) out.push('-', line);
        else out.push('-', line, '\n%\n');
      }
      for (let i = 0; i < c.ins; i++) {
        const line = bLines[c.p + i];
        if (line.endsWith('\n')) out.push('+', line);
        else out.push('+', line, '\n%\n');
      }
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) {
      const line = aLines[at];
      if (line.endsWith('\n')) out.push('=', line);
      else out.push('=', line, '\n%\n');
    }
  }
  return out.join('');
}
