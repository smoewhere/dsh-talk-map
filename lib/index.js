// src/host/digest/pipeline.ts
import { createHash } from "node:crypto";

// src/host/digest/extract.ts
var MAX_MESSAGES = 40;
var MAX_CHARS = 24e3;
function textOfBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((block) => typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
}
function extractFromSurface(events, capturedThroughSeq) {
  const lines = [];
  let todoNext;
  let lastSeq = capturedThroughSeq ?? 0;
  for (const event of events) {
    if (event.seq > lastSeq) lastSeq = event.seq;
    if (event.type === "user/message") {
      const message = event.data;
      const kind = message?.source?.kind;
      if (kind === "tool") continue;
      const text = textOfBlocks(message?.content);
      if (text !== "") lines.push({ role: "user", text });
    } else if (event.type === "assistant/message") {
      const data = event.data;
      const text = textOfBlocks(data?.message?.content);
      if (text !== "") lines.push({ role: "assistant", text });
    } else if (event.type === "todo/write") {
      const data = event.data;
      const open2 = data?.todos?.find((item) => item.status !== "completed");
      todoNext = open2?.content;
    }
  }
  const recent = lines.slice(-MAX_MESSAGES);
  let transcript = recent.map((line) => `${line.role === "user" ? "USER" : "ASSISTANT"}: ${line.text}`).join("\n\n");
  if (transcript.length > MAX_CHARS) {
    transcript = transcript.slice(transcript.length - MAX_CHARS);
  }
  return {
    transcript,
    ...todoNext !== void 0 && todoNext !== "" ? { todoNext } : {},
    lastSeq,
    messageCount: recent.length
  };
}

// src/host/digest/prompt.ts
var DIGEST_SYSTEM_PROMPT = [
  "You are a conversation digester for a visual conversation map.",
  "Read the conversation transcript and output STRICT JSON, nothing else:",
  '{"summary": string, "keyFindings": string[], "nextStep": string}',
  "",
  "Rules:",
  "- Use the language the conversation itself is in (Chinese conversation \u2192 Chinese output).",
  "- summary: what this conversation is about and where it stands, \u2264120 characters.",
  "- keyFindings: at most 5 short bullet strings \u2014 decisions made, facts established, artifacts produced.",
  "- nextStep: ONE imperative sentence naming the next concrete action to take, \u226440 characters.",
  "  The reader has ADHD and returns after days away \u2014 nextStep must be directly actionable,",
  '  never vague ("continue working" is forbidden; "run the M2 browser test" is right).',
  "- If the conversation is finished with nothing left to do, nextStep is an empty string.",
  "- Output raw JSON only: no markdown fences, no commentary."
].join("\n");
function digestUserPrompt(transcript) {
  return `Conversation transcript (oldest first):

${transcript}

Output the JSON digest now.`;
}
function parseDigestOutput(raw) {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("digest output contains no JSON object");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed.summary !== "string" || typeof parsed.nextStep !== "string" || !Array.isArray(parsed.keyFindings)) {
    throw new Error("digest output missing required fields");
  }
  return {
    summary: parsed.summary.slice(0, 300),
    keyFindings: parsed.keyFindings.filter((finding) => typeof finding === "string").slice(0, 5).map((finding) => finding.slice(0, 200)),
    nextStep: parsed.nextStep.slice(0, 120)
  };
}

// src/host/digest/pipeline.ts
var DIGEST_DEFAULTS = { enabled: true, idleMs: 3e4 };
var MIN_MESSAGES = 2;
var DigestPipeline = class {
  constructor(services, storeReady, config = DIGEST_DEFAULTS, onFresh, writeActive = (_id, write) => write()) {
    this.services = services;
    this.storeReady = storeReady;
    this.config = config;
    this.onFresh = onFresh;
    this.writeActive = writeActive;
  }
  services;
  storeReady;
  config;
  onFresh;
  writeActive;
  timers = /* @__PURE__ */ new Map();
  queue = [];
  queued = /* @__PURE__ */ new Set();
  draining = false;
  disposed = false;
  /** Wire the turn/end trigger; returns the disposer. */
  start() {
    const off = this.services.on("session/event", (...args) => {
      if (!this.config.enabled) return;
      const session = args[0];
      const event = args[1];
      if (event?.type !== "turn/end" || typeof session?.id !== "string") return;
      this.schedule(session.id);
    });
    return () => {
      this.disposed = true;
      off();
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    };
  }
  /** Debounced trigger: a busy session settles idleMs before digesting. */
  schedule(sessionId) {
    if (this.disposed) return;
    const existing = this.timers.get(sessionId);
    if (existing !== void 0) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.enqueue(sessionId);
    }, this.config.idleMs);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }
  /** Manual refresh: skips the debounce, forces regeneration (ignores hash). */
  async refresh(sessionId) {
    return await this.run(sessionId, { force: true });
  }
  /** Queue sessions that have no digest yet (imported/backlog cards). */
  backfill(sessionIds) {
    for (const sessionId of sessionIds) this.enqueue(sessionId);
  }
  enqueue(sessionId) {
    if (this.queued.has(sessionId)) return;
    this.queued.add(sessionId);
    this.queue.push(sessionId);
    void this.drain();
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const sessionId = this.queue.shift();
        if (sessionId === void 0) break;
        this.queued.delete(sessionId);
        try {
          await this.run(sessionId, { force: false });
        } catch (error) {
          this.services.logger?.warn(`[dsh-talk-map] digest for ${sessionId} failed: ${String(error)}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }
  async run(sessionId, options) {
    const store = await this.storeReady;
    const surface = await this.services.sessionQuery.readSurface(sessionId);
    const extracted = extractFromSurface(surface.events, surface.capturedThroughSeq);
    const previous = store.digests.get(sessionId);
    if (extracted.transcript === "" || extracted.messageCount < MIN_MESSAGES) {
      const digest = {
        atSeq: extracted.lastSeq,
        summary: previous?.summary ?? "",
        keyFindings: previous?.keyFindings ?? [],
        nextStep: previous?.nextStep ?? "",
        ...extracted.todoNext !== void 0 ? { todoNext: extracted.todoNext } : {},
        generatedAt: Date.now()
      };
      await this.persistDigest(store, sessionId, digest);
      return digest;
    }
    const inputHash = createHash("sha256").update(extracted.transcript).digest("hex");
    if (!options.force && previous?.inputHash === inputHash && previous.error === void 0) {
      return previous;
    }
    const route = this.services.agentDefaultModel.currentSelection();
    try {
      const raw = await this.generate(route, extracted.transcript, sessionId);
      const parsed = parseDigestOutput(raw);
      const digest = {
        atSeq: extracted.lastSeq,
        summary: parsed.summary,
        keyFindings: parsed.keyFindings,
        nextStep: parsed.nextStep,
        ...extracted.todoNext !== void 0 ? { todoNext: extracted.todoNext } : {},
        generatedAt: Date.now(),
        model: `${route.provider}/${route.model}`,
        inputHash
      };
      await this.persistDigest(store, sessionId, digest);
      if (previous?.inputHash !== inputHash) {
        try {
          this.onFresh?.(sessionId, digest);
        } catch (hookError) {
          this.services.logger?.warn(`[dsh-talk-map] onFresh hook failed: ${String(hookError)}`);
        }
      }
      return digest;
    } catch (error) {
      const digest = {
        atSeq: extracted.lastSeq,
        summary: previous?.summary ?? "",
        keyFindings: previous?.keyFindings ?? [],
        nextStep: previous?.nextStep ?? "",
        ...extracted.todoNext !== void 0 ? { todoNext: extracted.todoNext } : {},
        generatedAt: Date.now(),
        error: String(error).slice(0, 500)
      };
      await this.persistDigest(store, sessionId, digest);
      return digest;
    }
  }
  async persistDigest(store, id, digest) {
    await this.writeActive(id, async () => {
      if (this.disposed) throw new Error("digest pipeline disposed");
      await store.digests.put(id, digest);
    });
  }
  async generate(route, transcript, sessionId) {
    const message = {
      id: crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text: digestUserPrompt(transcript) }],
      source: { kind: "plugin", plugin: "dsh-talk-map" }
    };
    let text = "";
    let failure;
    for await (const chunk of this.services.llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [message],
      system: DIGEST_SYSTEM_PROMPT,
      maxTokens: 4096,
      sessionId
    })) {
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      else if (chunk.type === "finish" && chunk.reason !== void 0 && chunk.reason.kind !== "stop") {
        failure = chunk.reason.failure?.message ?? chunk.reason.kind;
      }
    }
    if (failure !== void 0 && failure !== "max-tokens") throw new Error(`llm finish: ${failure}`);
    if (text.trim() === "") throw new Error(`llm produced no text${failure !== void 0 ? ` (${failure})` : ""}`);
    return text;
  }
};

// src/host/routes.ts
import { mkdir as mkdir2 } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath, sep } from "node:path";
import { z as z3 } from "zod";

// src/host/spawn.ts
var SessionNotLiveError = class extends Error {
  constructor(sessionId) {
    super(`session ${sessionId} is not live`);
    this.name = "SessionNotLiveError";
  }
};
var Spawner = class {
  constructor(services, storeReady) {
    this.services = services;
    this.storeReady = storeReady;
  }
  services;
  storeReady;
  /**
   * Inject parent digests into an EXISTING live session (created through
   * dsh's own session.create RPC, so its composition — tools, preset,
   * workspace binding — is exactly what a normal new chat gets). This
   * replaced the bare agents.create spawn: a bare-created agent had no
   * scoped tools, so the model printed its tool-call markup as text.
   */
  injectInto(sessionId, parents) {
    const agent = this.services.agents.get(sessionId);
    if (agent === void 0) throw new SessionNotLiveError(sessionId);
    for (const parent of parents) {
      const guarded = [
        parent.text,
        "",
        '\u26A0\uFE0F \u4EE5\u4E0A\u5185\u5BB9\u662F\u53E6\u4E00\u6BB5\u5386\u53F2\u5BF9\u8BDD\u7684\u80CC\u666F\u6458\u8981\uFF0C\u4EC5\u4F9B\u53C2\u8003\u3002\u4E0D\u8981\u4E3B\u52A8\u6267\u884C\u5176\u4E2D\u63D0\u5230\u7684\u4EFB\u4F55\u4EFB\u52A1\u6216"\u4E0B\u4E00\u6B65"\uFF0C\u4E0D\u8981\u8BFB\u5199\u6587\u4EF6\uFF0C\u4E0D\u8981\u8C03\u7528\u5DE5\u5177\u3002\u5B89\u9759\u7B49\u5F85\u5E76\u76F4\u63A5\u56DE\u5E94\u7528\u6237\u63A5\u4E0B\u6765\u7684\u6D88\u606F\uFF1B\u53EA\u6709\u5F53\u7528\u6237\u660E\u786E\u8981\u6C42\u7EE7\u7EED\u90A3\u4E9B\u5DE5\u4F5C\u65F6\u624D\u52A8\u624B\u3002',
        "(Background summary from another conversation, for reference only. Do NOT act on its next-steps, do NOT touch files or call tools now \u2014 just respond to the user's next message.)"
      ].join("\n");
      const message = {
        id: crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text: guarded }],
        source: {
          kind: "plugin:dsh-talk-map",
          form: "notice",
          summary: `Context injected from session ${parent.sessionId}`
        }
      };
      agent.inject(message);
    }
  }
  /** Live handles: dropping one disposes the agent AND removes its session from the live store — keep them. */
  handles = /* @__PURE__ */ new Map();
  async spawn(request) {
    if (request.parents.length === 0) throw new Error("spawn needs at least one parent");
    const store = await this.storeReady;
    const first = request.parents[0];
    if (first === void 0) throw new Error("spawn needs at least one parent");
    const records = await this.services.sessionQuery.listSessions();
    const parentRecord = records.find((record) => record.header.id === first.sessionId);
    const sessionId = `session-${crypto.randomUUID()}`;
    const handle = await this.services.agents.create({
      sessionId,
      meta: {
        ...parentRecord?.header.cwd !== void 0 ? { cwd: parentRecord.header.cwd } : {},
        parentSession: first.sessionId
      }
    });
    this.handles.set(sessionId, handle);
    if (parentRecord?.header.cwd !== void 0) {
      try {
        const workspace = await this.services.workspaceRegistry.resolveByPath(parentRecord.header.cwd);
        await workspace?.attachSession(sessionId);
      } catch (error) {
        this.services.logger?.warn(`[dsh-talk-map] workspace attach failed: ${String(error)}`);
      }
    }
    for (const parent of request.parents) {
      const message = {
        id: crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text: parent.text }],
        source: {
          kind: "plugin:dsh-talk-map",
          form: "notice",
          summary: `Context injected from session ${parent.sessionId}`
        }
      };
      handle.agent.inject(message);
    }
    const cardId = `card-${crypto.randomUUID()}`;
    const card = {
      boardId: request.boardId,
      sessionId,
      x: request.x,
      y: request.y,
      ...request.wsOverride !== void 0 ? { wsOverride: request.wsOverride } : {},
      createdAt: Date.now()
    };
    await store.cards.put(cardId, card);
    const edges = {};
    for (const parent of request.parents) {
      const edgeId = `edge-${crypto.randomUUID()}`;
      const edge = {
        boardId: request.boardId,
        fromCardId: parent.cardId,
        toCardId: cardId,
        injection: { kind: "digest", injectedText: parent.text },
        createdAt: Date.now()
      };
      await store.edges.put(edgeId, edge);
      edges[edgeId] = edge;
    }
    this.services.logger?.info?.(`[dsh-talk-map] spawned ${sessionId} from ${request.parents.length} parent(s)`);
    return { sessionId, cardId, card, edges };
  }
};

// src/host/store.ts
import { z } from "zod";
var DOMAIN_NAME = "talk_map";
var INBOX_BOARD_ID = "inbox";
var boardSchema = z.object({
  name: z.string(),
  color: z.string(),
  order: z.number(),
  createdAt: z.number(),
  archivedAt: z.number().optional(),
  shelvedAt: z.number().optional()
});
var cardSchema = z.object({
  boardId: z.string(),
  sessionId: z.string(),
  x: z.number(),
  y: z.number(),
  colorTag: z.string().optional(),
  /** Map-level group override (set by dragging a card into another frame).
   * dsh @0.1.0-rc.6 has no cross-workspace session move RPC, so this is the
   * canvas's own organizational layer — the sidebar keeps its own truth. */
  wsOverride: z.string().optional(),
  createdAt: z.number()
});
var edgeInjectionSchema = z.object({
  /** 'link' = a plain association drawn between two EXISTING cards (no
   * spawn, no text); 'none' = a fork edge whose child inherited nothing. */
  kind: z.enum(["digest", "full", "selection", "none", "link"]),
  /** What was actually injected (post-edit), kept for provenance display. */
  injectedText: z.string().optional()
});
var edgeSchema = z.object({
  boardId: z.string(),
  fromCardId: z.string(),
  toCardId: z.string(),
  injection: edgeInjectionSchema,
  /** Handle sides ('t'|'r'|'b'|'l') the edge attaches to; absent = legacy r→l. */
  fromHandle: z.string().optional(),
  toHandle: z.string().optional(),
  /** Pipe mode: every substantive digest change of the source session is
   * pushed along this edge into the target session automatically. */
  autoSync: z.boolean().optional(),
  /** Source-session title snapshot (the host cannot resolve titles; the
   * client stamps it so auto-sync pushes can name their origin). */
  fromTitle: z.string().optional(),
  createdAt: z.number()
});
var digestSchema = z.object({
  /** Last session event seq folded into this digest (staleness anchor). */
  atSeq: z.number(),
  summary: z.string(),
  keyFindings: z.array(z.string()),
  /** The ADHD field: one imperative sentence — the next concrete action. */
  nextStep: z.string(),
  /** Zero-cost fallback lifted from the session's todo/write events. */
  todoNext: z.string().optional(),
  generatedAt: z.number(),
  model: z.string().optional(),
  error: z.string().optional(),
  /** sha256 of the transcript input — unchanged input skips regeneration. */
  inputHash: z.string().optional()
});
var cameraSchema = z.object({ x: z.number(), y: z.number(), zoom: z.number() });
var globalSchema = z.object({
  version: z.number(),
  activeBoard: z.string(),
  cameraByBoard: z.record(z.string(), cameraSchema),
  /** Auto-placement generation; absent = v1 (pre-workspace-grouping). */
  layoutVersion: z.number().optional(),
  /** Per-workspace color tags for the group frames. */
  wsColors: z.record(z.string(), z.string()).optional(),
  /** Manually sized frames (resize handle); absent = auto-fit to members. */
  wsFrames: z.record(z.string(), z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number()
  })).optional(),
  /** Map-toggle hotkey, e.g. "alt+KeyF" (modifiers + KeyboardEvent.code). */
  hotkey: z.string().optional(),
  /** Interface language of the map's own copy; absent = follow <html lang>. */
  locale: z.enum(["auto", "zh", "en"]).optional(),
  /** Last known placement per session — re-imports restore the arrangement. */
  layoutMemory: z.record(z.string(), z.object({
    x: z.number(),
    y: z.number(),
    colorTag: z.string().optional()
  })).optional()
});
var TALK_MAP_SPEC = {
  name: DOMAIN_NAME,
  version: 1,
  global: {
    schema: globalSchema,
    initial: { version: 1, activeBoard: INBOX_BOARD_ID, cameraByBoard: {} }
  },
  tables: {
    boards: { valueSchema: boardSchema },
    cards: { valueSchema: cardSchema },
    edges: { valueSchema: edgeSchema },
    digests: { valueSchema: digestSchema }
  }
};
async function openTalkMapStore(storageDomain) {
  const domain = await storageDomain.open(TALK_MAP_SPEC);
  const store = {
    domain,
    boards: domain.table("boards"),
    cards: domain.table("cards"),
    edges: domain.table("edges"),
    digests: domain.table("digests"),
    global: () => domain.global.get(),
    setGlobal: (value) => domain.global.set(value)
  };
  if (store.boards.get(INBOX_BOARD_ID) === void 0) {
    await store.boards.put(INBOX_BOARD_ID, {
      name: "Inbox",
      color: "gray",
      order: 0,
      createdAt: Date.now()
    });
  }
  return store;
}

// src/host/session-trash.ts
import { randomUUID, createHash as createHash2 } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import {
  copyFile,
  lstat as lstat2,
  mkdir,
  open,
  readdir as readdir2,
  realpath as realpath2,
  rename,
  unlink,
  readFile,
  rmdir
} from "node:fs/promises";
import { dirname, join as join2, relative as relative2, resolve as resolve2, isAbsolute as isAbsolute2, basename } from "node:path";
import { z as z2 } from "zod";

// src/host/session-lifecycle.ts
import { AsyncLocalStorage } from "node:async_hooks";
var KEY = /* @__PURE__ */ Symbol.for("dsh-talk-map.session-lifecycle.rc5.v1");
var ERROR = /* @__PURE__ */ Symbol.for("dsh-talk-map.lifecycle-error.v1");
var LifecycleError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
  [ERROR] = true;
};
var SessionLifecycle = class {
  internal = new AsyncLocalStorage();
  handles = /* @__PURE__ */ new WeakMap();
  pending = /* @__PURE__ */ new Map();
  guarded = /* @__PURE__ */ new WeakSet();
  frozen = /* @__PURE__ */ new Set();
  draining = /* @__PURE__ */ new Set();
  fence = () => false;
  host;
  constructor(source) {
    const host = this.host = {
      agents: source.agents,
      sessions: source.sessions,
      agentLoop: source.agentLoop,
      sessionPersistence: source.sessionPersistence
    };
    const self = this;
    const initialize = host.agentLoop.initializeAgent;
    host.agentLoop.initializeAgent = async function(...args) {
      const session = args[1].session;
      const header = session.header;
      try {
        self.assertEntry(header.id);
        if (header.origin === "subagent" && header.parentSession) self.assertEntry(header.parentSession);
      } catch (error) {
        await args[1].stored?.handle.close();
        throw error;
      }
      if (!self.guarded.has(session)) {
        self.guarded.add(session);
        const append = session.append;
        session.append = function(...values) {
          const completion = ["assistant/attempt", "assistant/message", "tool/result", "step/end", "turn/end"].includes(values[0]) || values[0] === "agent/inbox/spliced" && Array.isArray(values[1]?.messages) && values[1].messages.length === 0;
          if (!(self.draining.has(header.id) && completion)) self.assertWritable(header.id);
          return Reflect.apply(append, this, values);
        };
      }
      const task = self.own(async () => {
        const handle = await Reflect.apply(initialize, this, args);
        for (const name2 of ["send", "runMaintenance"]) {
          const original = handle.agent[name2];
          if (typeof original !== "function") continue;
          handle.agent[name2] = function(...values) {
            if (self.blocks(handle.agent.id)) throw new LifecycleError("SESSION_TRASHED", "\u4F1A\u8BDD\u6B63\u5728\u5220\u9664\u6216\u5DF2\u79FB\u5165\u56DE\u6536\u7AD9\uFF0C\u8BF7\u5148\u8FD8\u539F");
            return Reflect.apply(original, this, values);
          };
        }
        self.handles.set(handle.agent, handle);
        return handle;
      });
      self.track(header.id, task);
      return task;
    };
    for (const name2 of ["create", "resume"]) {
      const original = host.agents[name2];
      host.agents[name2] = async function(...args) {
        const options = args[0] ?? {};
        const id = options.sessionId ?? options.resumeSessionId;
        if (id) self.assertEntry(id);
        if (options.parentAgent) self.assertEntry(options.parentAgent.id);
        if (options.meta?.origin === "subagent" && options.meta.parentSession) self.assertEntry(options.meta.parentSession);
        const task = Reflect.apply(original, this, args);
        if (task instanceof Promise) {
          if (id) self.track(id, task);
          if (options.parentAgent) self.track(options.parentAgent.id, task);
          else if (options.meta?.origin === "subagent" && options.meta.parentSession) self.track(options.meta.parentSession, task);
        }
        return task;
      };
    }
    const create = host.sessionPersistence.create;
    if (typeof create === "function") host.sessionPersistence.create = async function(...args) {
      const header = args[0];
      self.assertEntry(header.id);
      if (header.origin === "subagent" && header.parentSession) self.assertEntry(header.parentSession);
      const task = (async () => {
        const handle = await Reflect.apply(create, this, args);
        try {
          self.assertEntry(header.id);
          return handle;
        } catch (error) {
          await handle.close();
          throw error;
        }
      })();
      self.track(header.id, task);
      if (header.origin === "subagent" && header.parentSession) self.track(header.parentSession, task);
      return task;
    };
    const open2 = host.sessionPersistence.open;
    host.sessionPersistence.open = async function(...args) {
      if (args[1] !== "write") return Reflect.apply(open2, this, args);
      self.assertWritable(args[0]);
      const task = (async () => {
        const handle = await Reflect.apply(open2, this, args);
        try {
          self.assertWritable(args[0]);
          return handle;
        } catch (error) {
          await handle.close();
          throw error;
        }
      })();
      self.track(args[0], task);
      return task;
    };
  }
  track(id, task) {
    const group = this.pending.get(id) ?? /* @__PURE__ */ new Set();
    this.pending.set(id, group);
    group.add(task);
    const done = () => {
      group.delete(task);
      if (!group.size) this.pending.delete(id);
    };
    void task.then(done, done);
  }
  drain(ids) {
    ids.forEach((id) => this.draining.add(id));
    return () => ids.forEach((id) => this.draining.delete(id));
  }
  blocks(id) {
    return this.frozen.has(id) || this.fence(id);
  }
  setFence(fence) {
    this.fence = fence;
  }
  assertEntry(id) {
    if (this.blocks(id)) throw new LifecycleError("SESSION_TRASHED", "\u4F1A\u8BDD\u6B63\u5728\u5220\u9664\u6216\u5DF2\u79FB\u5165\u56DE\u6536\u7AD9\uFF0C\u8BF7\u5148\u8FD8\u539F");
  }
  assertWritable(id) {
    if (!this.internal.getStore()?.active && this.blocks(id))
      throw new LifecycleError("SESSION_TRASHED", "\u4F1A\u8BDD\u6B63\u5728\u5220\u9664\u6216\u5DF2\u79FB\u5165\u56DE\u6536\u7AD9\uFF0C\u8BF7\u5148\u8FD8\u539F");
  }
  async own(operation) {
    const token = { active: true };
    return this.internal.run(token, async () => {
      try {
        return await operation();
      } finally {
        token.active = false;
      }
    });
  }
  async freeze(ids) {
    ids.forEach((id) => this.frozen.add(id));
    try {
      for (const id of ids) await Promise.allSettled([...this.pending.get(id) ?? []]);
      for (const id of ids) {
        const live = this.host.sessions.get(id), agent = this.host.agents.get(id);
        if ((live || agent) && (!agent || !this.handles.has(agent) || this.handles.get(agent).agent.session !== live))
          throw new LifecycleError("SESSION_RELEASE_UNAVAILABLE", `\u4F1A\u8BDD ${id} \u7F3A\u5C11\u539F\u751F\u91CA\u653E\u53E5\u67C4\uFF1B\u9996\u6B21\u5347\u7EA7\u540E\u8BF7\u6B63\u5E38\u91CD\u542F DSH \u4E00\u6B21`);
      }
      return () => ids.forEach((id) => this.frozen.delete(id));
    } catch (error) {
      ids.forEach((id) => this.frozen.delete(id));
      throw error;
    }
  }
  async release(ids) {
    for (const id of [...ids].reverse()) {
      const agent = this.host.agents.get(id);
      const handle = agent && this.handles.get(agent);
      if (!handle) continue;
      try {
        await this.own(() => handle.dispose());
      } catch (error) {
        throw new LifecycleError("SESSION_RELEASE_FAILED", `\u4F1A\u8BDD ${id} \u91CA\u653E\u5931\u8D25\uFF1A${String(error)}`);
      }
      if (this.host.sessions.get(id) || this.host.agents.get(id))
        throw new LifecycleError("SESSION_RELEASE_FAILED", `\u4F1A\u8BDD ${id} \u5C1A\u672A\u5B8C\u6210\u91CA\u653E\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5`);
      this.handles.delete(agent);
    }
  }
};
function installSessionLifecycle(host) {
  if (host.agents[KEY]) return host.agents[KEY];
  if (typeof host.agentLoop?.initializeAgent !== "function" || typeof host.agents.create !== "function" || typeof host.agents.resume !== "function") return void 0;
  const adapter = new SessionLifecycle(host);
  Object.defineProperty(host.agents, KEY, { value: adapter });
  return adapter;
}
function sessionLifecycleFor(agents) {
  return agents[KEY];
}
function isLifecycleError(error) {
  return typeof error === "object" && error !== null && error[ERROR] === true;
}

// src/host/storage-usage.ts
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
async function directorySize(home, target) {
  let sizeBytes = 0, complete = true;
  const root = await realpath(home);
  const rel = relative(root, resolve(target));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../"))
    return { sizeBytes: 0, complete: false };
  let cursor = root;
  try {
    for (const part of rel.split(/[\\/]/)) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink() || resolve(await realpath(cursor)) !== resolve(cursor))
        return { sizeBytes: 0, complete: false };
    }
  } catch (error) {
    return { sizeBytes: 0, complete: error.code === "ENOENT" };
  }
  const walk = async (path) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        complete = false;
        return;
      }
      if (info.isFile()) {
        sizeBytes += info.size;
        return;
      }
      if (!info.isDirectory()) {
        complete = false;
        return;
      }
      for (const name2 of await readdir(path)) await walk(join(path, name2));
    } catch {
      complete = false;
    }
  };
  await walk(cursor);
  return { sizeBytes, complete };
}
async function storageUsage(home) {
  const [sessions, projectionCache, trash, attachments] = await Promise.all([
    "sessions",
    "storages/session_projcache",
    "talk-map-trash",
    "attachments"
  ].map((path) => directorySize(home, join(home, path))));
  const categories = { sessions, projectionCache, trash, attachments };
  return { categories, measuredAt: Date.now(), complete: Object.values(categories).every((v) => v.complete) };
}

// src/host/session-trash.ts
var safeId = z2.string().min(1).max(160).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/).refine((id) => id !== "." && id !== "..");
var entryId = z2.string().uuid();
var headerSchema = z2.object({
  id: safeId,
  version: z2.literal(4),
  createdAt: z2.number(),
  cwd: z2.string().optional(),
  parentSession: z2.string().optional(),
  origin: z2.literal("subagent").optional(),
  isSeeded: z2.boolean()
}).passthrough();
var fileSchema = z2.object({
  sessionId: safeId,
  source: z2.string(),
  name: z2.string(),
  hash: z2.string().regex(/^[a-f0-9]{64}$/)
});
var manifestSchema = z2.object({
  version: z2.literal(1),
  entryId,
  sessionId: safeId,
  title: z2.string(),
  deletedAt: z2.number(),
  state: z2.enum(["staging", "trashed", "restoring", "restored", "purging", "purged", "failed"]),
  operation: z2.enum(["trash", "restore", "purge"]),
  error: z2.string().optional(),
  headers: z2.array(headerSchema).min(1),
  files: z2.array(fileSchema).min(1),
  memberships: z2.array(
    z2.object({
      sessionId: safeId,
      workspaceId: z2.string(),
      path: z2.string(),
      title: z2.string(),
      before: z2.string().optional()
    })
  ),
  archived: z2.array(safeId),
  pinned: z2.array(safeId),
  cache: z2.record(z2.string(), z2.unknown()),
  map: z2.object({
    cards: z2.record(z2.string(), cardSchema),
    edges: z2.record(z2.string(), edgeSchema),
    digests: z2.record(z2.string(), digestSchema),
    memory: z2.record(
      z2.string(),
      z2.object({ x: z2.number(), y: z2.number(), colorTag: z2.string().optional() })
    )
  })
}).refine((m) => {
  const ids = new Set(m.headers.map((h) => h.id));
  return ids.size === m.headers.length && ids.has(m.sessionId) && m.files.every((f) => ids.has(f.sessionId)) && m.memberships.every((w) => ids.has(w.sessionId)) && [
    ...m.archived,
    ...m.pinned,
    ...Object.keys(m.cache),
    ...Object.keys(m.map.memory),
    ...Object.keys(m.map.digests)
  ].every((id) => ids.has(id)) && Object.values(m.map.cards).every((c) => ids.has(c.sessionId)) && Object.values(m.map.edges).every(
    (e) => m.map.cards[e.fromCardId] !== void 0 || m.map.cards[e.toCardId] !== void 0
  );
}, "manifest ownership mismatch");
var LOG_NAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/;
var TrashError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
  code;
  details;
};
function fail(code, message) {
  throw new TrashError(code, message);
}
var exists = async (path) => {
  try {
    await lstat2(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};
var hash = async (path) => {
  const digest = createHash2("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
};
var SessionTrash = class {
  constructor(services, store, home) {
    this.services = services;
    this.store = store;
    this.home = home;
  }
  services;
  store;
  home;
  chain = Promise.resolve();
  blocked = /* @__PURE__ */ new Set();
  deleting = /* @__PURE__ */ new Set();
  entries = /* @__PURE__ */ new Map();
  purged = /* @__PURE__ */ new Set();
  root = "";
  sessionsRoot = "";
  ready = false;
  get lifecycle() {
    const adapter = sessionLifecycleFor(this.services.agents);
    adapter?.setFence((id) => this.isBlocked(id));
    return adapter;
  }
  serial(operation) {
    const task = this.chain.then(operation);
    this.chain = task.catch(() => void 0);
    return task;
  }
  isBlocked(id) {
    return this.deleting.has(id) || this.blocked.has(id) || this.purged.has(id);
  }
  async close() {
    await this.serial(async () => {
      this.ready = false;
    });
  }
  async writeActive(ids, operation) {
    return this.serial(async () => {
      this.requireReady();
      if (ids.some((id) => this.isBlocked(id))) fail("SESSION_TRASHED", "\u4F1A\u8BDD\u5DF2\u79FB\u5165\u56DE\u6536\u7AD9");
      return operation();
    });
  }
  requireReady() {
    if (!this.ready) fail("SERVICE_UNAVAILABLE", "\u56DE\u6536\u7AD9\u6B63\u5728\u521D\u59CB\u5316\u6216\u6062\u590D");
  }
  cache() {
    const domain = this.services.storageDomain.get("session_projcache");
    if (!domain) return fail("SERVICE_UNAVAILABLE", "\u4F1A\u8BDD\u7F13\u5B58\u670D\u52A1\u4E0D\u53EF\u7528");
    return domain.table("sessions");
  }
  async inside(root, target, missing = false) {
    const abs = resolve2(target);
    const rel = relative2(root, abs);
    if (!rel || isAbsolute2(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../"))
      fail("PATH_UNSAFE", "\u4F1A\u8BDD\u6587\u4EF6\u8DEF\u5F84\u4E0D\u5B89\u5168");
    let cursor = root;
    for (const part of rel.split(/[\\/]/)) {
      cursor = join2(cursor, part);
      try {
        const info = await lstat2(cursor);
        if (info.isSymbolicLink()) fail("PATH_UNSAFE", "\u4F1A\u8BDD\u6587\u4EF6\u4E0D\u80FD\u901A\u8FC7\u7B26\u53F7\u94FE\u63A5\u8BBF\u95EE");
        const actual = await realpath2(cursor);
        const r = relative2(root, actual);
        if (isAbsolute2(r) || r === ".." || r.startsWith("..\\") || r.startsWith("../"))
          fail("PATH_UNSAFE", "\u4F1A\u8BDD\u6587\u4EF6\u8D85\u51FA\u5141\u8BB8\u76EE\u5F55");
      } catch (e) {
        if (missing && e.code === "ENOENT") continue;
        throw e;
      }
    }
    return abs;
  }
  entryDir(id) {
    return join2(this.root, entryId.parse(id));
  }
  async pruneUnstarted(dir) {
    const names = await readdir2(dir);
    if (names.some((name2) => name2 !== "manifest.tmp")) fail("PATH_UNSAFE", "\u56DE\u6536\u7AD9\u6761\u76EE\u7F3A\u5C11\u64CD\u4F5C\u6E05\u5355");
    if (names.includes("manifest.tmp")) {
      const temp = await this.inside(this.root, join2(dir, "manifest.tmp"));
      if (!(await lstat2(temp)).isFile()) fail("PATH_UNSAFE", "\u56DE\u6536\u7AD9\u4E34\u65F6\u6E05\u5355\u4E0D\u662F\u666E\u901A\u6587\u4EF6");
      await unlink(temp);
    }
    await rmdir(dir);
  }
  async save(m) {
    const dir = await this.inside(this.root, this.entryDir(m.entryId));
    const target = await this.inside(this.root, join2(dir, "manifest.json"), true);
    const temp = await this.inside(this.root, join2(dir, "manifest.tmp"), true);
    const fd = await open(temp, "w", 384);
    try {
      await fd.writeFile(JSON.stringify(m));
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temp, target);
    this.entries.set(m.entryId, m);
  }
  async source(f, m) {
    const h = m.headers.find((h2) => h2.id === f.sessionId);
    if (!h || !LOG_NAME.test(f.name) || basename(f.name) !== f.name)
      return fail("PATH_UNSAFE", "\u56DE\u6536\u7AD9\u6587\u4EF6\u6E05\u5355\u65E0\u6548");
    const located = this.services.sessionPersistence.locate(h);
    if (located.kind !== "jsonl") fail("SERVICE_UNAVAILABLE", "\u5F53\u524D\u6301\u4E45\u5316\u683C\u5F0F\u6682\u4E0D\u652F\u6301\u56DE\u6536\u7AD9");
    const target = await this.inside(this.sessionsRoot, join2(this.sessionsRoot, f.source), true);
    if (dirname(target) !== resolve2(dirname(located.path)) || basename(target) !== f.name)
      fail("PATH_UNSAFE", "\u65E5\u5FD7\u6587\u4EF6\u4E0E\u4F1A\u8BDD\u8EAB\u4EFD\u4E0D\u5339\u914D");
    return target;
  }
  async saved(f, m) {
    return this.inside(this.root, join2(this.entryDir(m.entryId), "logs", f.sessionId, f.name), true);
  }
  async move(from, to, expected) {
    if (await exists(to)) fail("RESTORE_CONFLICT", "\u76EE\u6807\u6587\u4EF6\u5DF2\u5B58\u5728");
    if (!(await lstat2(from)).isFile() || await hash(from) !== expected)
      fail("FILE_CHANGED", "\u4F1A\u8BDD\u6587\u4EF6\u5728\u64CD\u4F5C\u671F\u95F4\u53D1\u751F\u53D8\u5316");
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to, constants.COPYFILE_EXCL);
    const fd = await open(to, "r+");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    if (await hash(to) !== expected || await hash(from) !== expected)
      fail("FILE_CHANGED", "\u4F1A\u8BDD\u6587\u4EF6\u6821\u9A8C\u5931\u8D25");
    await unlink(from);
  }
  async verifyLog(path, id) {
    const source = createReadStream(path, { highWaterMark: 4096 });
    const stream = path.endsWith(".zstd") ? source.pipe(createZstdDecompress()) : source;
    if (stream !== source) source.on("error", (error) => stream.destroy(error));
    let first = Buffer.alloc(0);
    try {
      for await (const bytes of stream) {
        first = Buffer.concat([first, Buffer.from(bytes)]);
        const end = first.indexOf(10);
        if (end >= 0) {
          let header;
          try {
            header = JSON.parse(first.subarray(0, end).toString("utf8"));
          } catch {
            fail("PATH_UNSAFE", "\u65E5\u5FD7\u5934\u65E0\u6CD5\u9A8C\u8BC1");
          }
          if (typeof header !== "object" || header === null || header.id !== id)
            fail("PATH_UNSAFE", "\u65E5\u5FD7\u4E0D\u5C5E\u4E8E\u76EE\u6807\u4F1A\u8BDD");
          return;
        }
        if (first.length > 1024 * 1024) fail("PATH_UNSAFE", "\u65E5\u5FD7\u5934\u8FC7\u5927\uFF0C\u65E0\u6CD5\u9A8C\u8BC1");
      }
      fail("PATH_UNSAFE", "\u4F1A\u8BDD\u65E5\u5FD7\u7F3A\u5C11\u53EF\u9A8C\u8BC1\u7684\u6587\u4EF6\u5934");
    } finally {
      stream.destroy();
      source.destroy();
    }
  }
  async activity(headers) {
    const blockingSessionIds = [], activityKinds = /* @__PURE__ */ new Set();
    for (const h of headers) {
      const activities = await this.services.waterfall("workspace/session-activity", { sessionId: h.id }, async () => []);
      const status = this.services.agents.get(h.id)?.status;
      if (status && status !== "idle" || activities.length) {
        blockingSessionIds.push(h.id);
        if (status && status !== "idle") activityKinds.add("turn");
        for (const item of activities) activityKinds.add(String(item?.kind ?? "activity"));
      }
    }
    return { blockingSessionIds, activityKinds: [...activityKinds] };
  }
  async ensureAvailable(headers) {
    const activity = await this.activity(headers);
    if (activity.blockingSessionIds.length)
      throw new TrashError("SESSION_RUNNING", "\u4F1A\u8BDD\u6216\u5B50\u4EE3\u7406\u4ECD\u6709\u6D3B\u52A8\uFF1A" + activity.blockingSessionIds.join("\u3001"), activity);
    for (const h of headers)
      if (this.services.sessions.get(h.id) || this.services.agents.get(h.id))
        fail("SESSION_IN_USE", `\u4F1A\u8BDD ${h.id} \u5C1A\u672A\u5B8C\u6210\u91CA\u653E\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5`);
  }
  async prepare(headers, stopActivity) {
    const checkPaths = async () => {
      for (const h of headers) {
        const location = this.services.sessionPersistence.locate(h);
        if (location.kind !== "jsonl") fail("SERVICE_UNAVAILABLE", "\u5F53\u524D\u5B58\u50A8\u683C\u5F0F\u4E0D\u652F\u6301\u56DE\u6536\u7AD9");
        await this.inside(this.sessionsRoot, location.path);
      }
    };
    await checkPaths();
    const ids = headers.map((h) => h.id);
    const activity = await this.activity(headers);
    if (activity.blockingSessionIds.length && !stopActivity)
      throw new TrashError("SESSION_RUNNING", "\u4F1A\u8BDD\u6216\u5B50\u4EE3\u7406\u4ECD\u6709\u6D3B\u52A8\uFF1A" + activity.blockingSessionIds.join("\u3001"), activity);
    ids.forEach((id) => this.deleting.add(id));
    const thaws = [];
    try {
      if (this.lifecycle) {
        thaws.push(await this.lifecycle.freeze(ids));
        const records = await this.services.sessionPersistence.list();
        for (let i = 0; i < headers.length; i++) {
          const added = [];
          for (const record of records) {
            const h = record.header;
            if (h.origin === "subagent" && h.parentSession === headers[i].id && !ids.includes(h.id)) {
              if (record.formatStatus && record.formatStatus !== "current") fail("UNSUPPORTED_SESSION_FORMAT", "\u8BF7\u5148\u901A\u8FC7 DSH \u5347\u7EA7\u6B64\u4F1A\u8BDD\u683C\u5F0F");
              headers.push(headerSchema.parse(h));
              ids.push(h.id);
              added.push(h.id);
              this.deleting.add(h.id);
            }
          }
          if (added.length) thaws.push(await this.lifecycle.freeze(added));
        }
      } else if (ids.some((id) => this.services.sessions.get(id) || this.services.agents.get(id)))
        fail("SESSION_RELEASE_UNAVAILABLE", "\u7F3A\u5C11\u539F\u751F\u91CA\u653E\u53E5\u67C4\uFF1B\u9996\u6B21\u5347\u7EA7\u540E\u8BF7\u6B63\u5E38\u91CD\u542F DSH \u4E00\u6B21");
      await checkPaths();
      if (stopActivity && (await this.activity(headers)).blockingSessionIds.length) {
        if (!this.services.parallel) fail("SERVICE_UNAVAILABLE", "\u5BBF\u4E3B\u672A\u63D0\u4F9B\u505C\u6B62\u6D3B\u52A8\u63A5\u53E3");
        const endDrain = this.lifecycle?.drain(ids);
        const deadline = Date.now() + 15e3;
        let expired = false;
        let timer;
        try {
          await Promise.race([
            (async () => {
              for (const h of headers) {
                if (expired) return;
                const stop = () => this.services.parallel("workspace/session-stop", { sessionId: h.id });
                await (this.lifecycle ? this.lifecycle.own(stop) : stop());
              }
              while (!expired && (await this.activity(headers)).blockingSessionIds.length) {
                if (Date.now() >= deadline) fail("SESSION_STOP_TIMEOUT", "\u505C\u6B62\u4EFB\u52A1\u8D85\u65F6\uFF0C\u6587\u4EF6\u5C1A\u672A\u642C\u79FB\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
                await new Promise((resolve4) => setTimeout(resolve4, 100));
              }
            })(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new TrashError("SESSION_STOP_TIMEOUT", "\u505C\u6B62\u4EFB\u52A1\u8D85\u65F6\uFF0C\u6587\u4EF6\u5C1A\u672A\u642C\u79FB\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5")), 15e3);
            })
          ]);
        } finally {
          expired = true;
          clearTimeout(timer);
          endDrain?.();
        }
      }
      const remaining = await this.activity(headers);
      if (remaining.blockingSessionIds.length)
        throw new TrashError("SESSION_RUNNING", "\u4F1A\u8BDD\u4ECD\u6709\u6D3B\u52A8", remaining);
      await this.lifecycle?.release(ids);
      await this.ensureAvailable(headers);
      return () => {
        thaws.forEach((thaw) => thaw());
        ids.forEach((id) => this.deleting.delete(id));
      };
    } catch (error) {
      thaws.forEach((thaw) => thaw());
      ids.forEach((id) => this.deleting.delete(id));
      throw error;
    }
  }
  async pruneSources(headers) {
    for (const h of headers) {
      try {
        const dir = await this.inside(this.sessionsRoot, dirname(this.services.sessionPersistence.locate(h).path));
        await rmdir(dir);
        const parent = dirname(dir);
        if (parent !== this.sessionsRoot) await rmdir(await this.inside(this.sessionsRoot, parent));
      } catch (error) {
        const code = error.code;
        if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EBUSY"].includes(code ?? ""))
          this.services.logger?.warn(`[talk-map] empty directory cleanup: ${String(error)}`);
      }
    }
  }
  async initialize() {
    const persistence = this.services.sessionPersistence;
    if (typeof persistence.locate !== "function" || typeof persistence.acquireLease !== "function" || typeof persistence.open !== "function")
      fail("SERVICE_UNAVAILABLE", "\u5F53\u524D\u6301\u4E45\u5316\u670D\u52A1\u4E0D\u652F\u6301\u5B89\u5168\u56DE\u6536\u7AD9");
    const home = await realpath2(this.home);
    this.sessionsRoot = await realpath2(join2(home, "sessions"));
    if (await realpath2(persistence.root) !== this.sessionsRoot)
      fail("SERVICE_UNAVAILABLE", "\u5F53\u524D\u4F1A\u8BDD\u6839\u76EE\u5F55\u6682\u4E0D\u652F\u6301\u56DE\u6536\u7AD9");
    const trash = await this.inside(home, join2(home, "talk-map-trash"), true);
    await mkdir(trash, { recursive: true, mode: 448 });
    this.root = await this.inside(home, join2(trash, "entries"), true);
    await mkdir(this.root, { recursive: true, mode: 448 });
    this.cache();
    const purgedPath = await this.inside(home, join2(trash, "purged.json"), true);
    if (await exists(purgedPath))
      for (const id of z2.array(safeId).parse(JSON.parse(await readFile(purgedPath, "utf8"))))
        this.purged.add(id);
    for (const item of await readdir2(this.root, { withFileTypes: true })) {
      if (!item.isDirectory() || !entryId.safeParse(item.name).success)
        fail("PATH_UNSAFE", "\u56DE\u6536\u7AD9\u76EE\u5F55\u5305\u542B\u65E0\u6CD5\u8BC6\u522B\u7684\u6761\u76EE");
      if ((await readdir2(await this.inside(this.root, join2(this.root, item.name)))).length === 0) {
        await rmdir(join2(this.root, item.name));
        continue;
      }
      const manifestPath = join2(this.root, item.name, "manifest.json");
      if (!await exists(manifestPath)) {
        await this.pruneUnstarted(await this.inside(this.root, join2(this.root, item.name)));
        continue;
      }
      const path = await this.inside(this.root, manifestPath);
      const m = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (m.entryId !== item.name || !m.headers.some((h) => h.id === m.sessionId))
        fail("PATH_UNSAFE", "\u56DE\u6536\u7AD9\u6761\u76EE\u8EAB\u4EFD\u4E0D\u5339\u914D");
      for (const f of m.files) {
        await this.source(f, m);
        await this.saved(f, m);
      }
      this.entries.set(m.entryId, m);
      if (!["restored", "purged"].includes(m.state))
        m.headers.forEach((h) => this.blocked.add(h.id));
    }
    for (const m of this.entries.values()) {
      if (m.state === "restored") {
        await this.discardEntry(m);
        continue;
      }
      if (["staging", "restoring", "purging", "failed"].includes(m.state)) {
        try {
          await this.recover(m);
        } catch (e) {
          m.state = "failed";
          m.error = String(e);
          await this.save(m);
        }
      }
    }
    this.lifecycle?.setFence((id) => this.isBlocked(id));
    this.ready = true;
  }
  list() {
    this.requireReady();
    return [...this.entries.values()].filter((m) => !["restored", "purged"].includes(m.state)).map((m) => ({
      entryId: m.entryId,
      sessionId: m.sessionId,
      title: m.title,
      sessionCount: m.headers.length,
      workspace: m.memberships[0]?.title ?? "",
      deletedAt: m.deletedAt,
      state: m.state,
      error: m.error ? "\u64CD\u4F5C\u672A\u5B8C\u6210\uFF0C\u8BF7\u91CD\u542F DSH \u540E\u91CD\u8BD5" : void 0
    })).sort((a, b) => b.deletedAt - a.deletedAt);
  }
  async listing() {
    return this.serial(async () => Promise.all(this.list().map(async (entry) => {
      const size = await directorySize(this.home, this.entryDir(entry.entryId));
      return { ...entry, sizeBytes: size.complete ? size.sizeBytes : null };
    })));
  }
  async storage() {
    return storageUsage(this.home);
  }
  result(requestId, m, status, error) {
    if (error) this.services.logger?.warn(`[talk-map] ${requestId}: ${String(error)}`);
    const locked = error?.name === "SessionAlreadyOwnedError";
    return {
      requestId,
      sessionId: m?.sessionId ?? (safeId.safeParse(requestId).success ? requestId : void 0),
      entryId: m?.entryId,
      affectedSessionIds: status === "failed" ? [] : m?.headers.map((h) => h.id) ?? [],
      status,
      ...error ? {
        error: {
          ...error instanceof TrashError ? error.details : {},
          code: error instanceof TrashError || isLifecycleError(error) ? error.code : locked ? "SESSION_IN_USE" : "INTERNAL_ERROR",
          message: error instanceof TrashError || isLifecycleError(error) ? error.message : locked ? "\u4F1A\u8BDD\u6587\u4EF6\u4ECD\u88AB\u5360\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" : "\u64CD\u4F5C\u5931\u8D25\uFF0C\u6570\u636E\u5DF2\u4FDD\u7559\u6216\u7B49\u5F85\u6062\u590D\uFF0C\u8BF7\u91CD\u8BD5"
        }
      } : {}
    };
  }
  async trash(ids, options = {}) {
    return this.serial(async () => {
      this.requireReady();
      const results = [];
      const ordered = [...new Set(ids)];
      try {
        const headers = new Map(
          (await this.services.sessionPersistence.list()).map((r) => {
            const h = r.header;
            return [h.id, h];
          })
        );
        const depth = (id) => {
          const seen = /* @__PURE__ */ new Set();
          let current = headers.get(id);
          while (current?.origin === "subagent" && current.parentSession && !seen.has(current.id)) {
            seen.add(current.id);
            current = headers.get(current.parentSession);
          }
          return seen.size;
        };
        ordered.sort((a, b) => depth(a) - depth(b));
      } catch {
      }
      for (const id of ordered) {
        let m;
        let journaled = false;
        let release;
        let selected = [];
        const handles = [];
        try {
          safeId.parse(id);
          const previous = [...this.entries.values()].find(
            (m2) => m2.headers.some((h) => h.id === id) && m2.state === "trashed"
          );
          if (previous) {
            results.push(this.result(id, previous, "trashed"));
            continue;
          }
          if (this.isBlocked(id)) fail("SESSION_IN_USE", "\u6B64\u4F1A\u8BDD\u6709\u672A\u5B8C\u6210\u7684\u56DE\u6536\u7AD9\u64CD\u4F5C");
          const records = await this.services.sessionPersistence.list();
          const root = records.find((r) => r.header.id === id);
          if (!root) fail("SESSION_NOT_FOUND", "\u4F1A\u8BDD\u4E0D\u5B58\u5728");
          const headers = [headerSchema.parse(root.header)];
          for (let i = 0; i < headers.length; i++)
            for (const r of records) {
              const h = r.header;
              if (h.origin === "subagent" && h.parentSession === headers[i].id && !headers.some((x) => x.id === h.id))
                headers.push(headerSchema.parse(h));
            }
          if (headers.some(
            (h) => records.find((r) => r.header.id === h.id)?.formatStatus && records.find((r) => r.header.id === h.id)?.formatStatus !== "current"
          ))
            fail("UNSUPPORTED_SESSION_FORMAT", "\u8BF7\u5148\u901A\u8FC7 DSH \u5347\u7EA7\u6B64\u4F1A\u8BDD\u683C\u5F0F");
          selected = headers;
          release = await this.prepare(headers, options.stopActivity === true);
          for (const h of headers)
            await this.inside(this.sessionsRoot, this.services.sessionPersistence.locate(h).path);
          for (const h of [...headers].sort((a, b) => a.id.localeCompare(b.id)))
            handles.push(await (this.lifecycle ? this.lifecycle.own(() => this.services.sessionPersistence.open(h.id, "write")) : this.services.sessionPersistence.open(h.id, "write")));
          await this.ensureAvailable(headers);
          const wanted = new Set(headers.map((h) => h.id));
          const files = [];
          for (const h of headers) {
            const location = this.services.sessionPersistence.locate(h);
            if (location.kind !== "jsonl") fail("SERVICE_UNAVAILABLE", "\u5F53\u524D\u5B58\u50A8\u683C\u5F0F\u4E0D\u652F\u6301\u56DE\u6536\u7AD9");
            const path = await this.inside(this.sessionsRoot, location.path);
            for (const item of await readdir2(dirname(path), { withFileTypes: true })) {
              if (!LOG_NAME.test(item.name)) continue;
              const source = await this.inside(this.sessionsRoot, join2(dirname(path), item.name));
              if (!item.isFile()) fail("PATH_UNSAFE", "\u4F1A\u8BDD\u65E5\u5FD7\u4E0D\u662F\u666E\u901A\u6587\u4EF6");
              await this.verifyLog(source, h.id);
              files.push({
                sessionId: h.id,
                source: relative2(this.sessionsRoot, source),
                name: item.name,
                hash: await hash(source)
              });
            }
          }
          if (files.length === 0 || headers.some((h) => !files.some((f) => f.sessionId === h.id)))
            fail("SESSION_NOT_FOUND", "\u627E\u4E0D\u5230\u5B8C\u6574\u7684\u4F1A\u8BDD\u65E5\u5FD7");
          const cards = Object.fromEntries(
            [...this.store.cards.entries()].filter(([, c]) => wanted.has(c.sessionId))
          );
          const cardIds = new Set(Object.keys(cards));
          const global = this.store.global();
          m = {
            version: 1,
            entryId: randomUUID(),
            sessionId: id,
            title: this.title(headers[0]),
            deletedAt: Date.now(),
            state: "staging",
            operation: "trash",
            headers,
            files,
            memberships: this.services.workspaceRegistry.list().flatMap(
              (w) => w.sessionIds.filter((s) => wanted.has(s)).map((s) => ({
                sessionId: s,
                workspaceId: w.id,
                path: w.path,
                title: w.title,
                before: w.sessionIds[w.sessionIds.indexOf(s) + 1]
              }))
            ),
            archived: this.services.workspaceRegistry.archivedSessionIds.filter(
              (s) => wanted.has(s)
            ),
            pinned: this.services.workspaceRegistry.pinnedSessionIds.filter((s) => wanted.has(s)),
            cache: Object.fromEntries(
              headers.flatMap((h) => {
                const v = this.cache().get(h.id);
                return v === void 0 ? [] : [[h.id, v]];
              })
            ),
            map: {
              cards,
              edges: Object.fromEntries(
                [...this.store.edges.entries()].filter(
                  ([, e]) => cardIds.has(e.fromCardId) || cardIds.has(e.toCardId)
                )
              ),
              digests: Object.fromEntries(
                [...this.store.digests.entries()].filter(([s]) => wanted.has(s))
              ),
              memory: Object.fromEntries(
                Object.entries(global.layoutMemory ?? {}).filter(([s]) => wanted.has(s))
              )
            }
          };
          m = manifestSchema.parse(m);
          await mkdir(await this.inside(this.root, this.entryDir(m.entryId), true), { mode: 448 });
          await this.save(m);
          journaled = true;
          headers.forEach((h) => this.blocked.add(h.id));
          for (const f of files)
            await this.move(await this.source(f, m), await this.saved(f, m), f.hash);
          await this.removeMetadata(m);
          m.state = "trashed";
          await this.save(m);
          for (const h of headers) this.publish("api-session/removed", h.id);
          results.push(this.result(id, m, "trashed"));
        } catch (error) {
          if (m && journaled) {
            try {
              await this.recover(m, true);
            } catch (rollback) {
              m.state = "failed";
              m.error = String(rollback);
              await this.save(m);
            }
          }
          if (m && !journaled && await exists(this.entryDir(m.entryId))) {
            try {
              await this.pruneUnstarted(await this.inside(this.root, this.entryDir(m.entryId)));
            } catch (cleanup) {
              this.services.logger?.warn(`[talk-map] unstarted entry: ${String(cleanup)}`);
            }
          }
          results.push(this.result(id, m, "failed", error));
        } finally {
          try {
            for (const h of handles.reverse()) await h.close();
          } finally {
            release?.();
          }
          if (m?.state === "trashed") await this.pruneSources(selected);
        }
      }
      return results;
    });
  }
  title(h) {
    const value = this.services.sessionProjectionCache.cachedSnapshot(h)?.values.title;
    return typeof value === "string" && value ? value : h.id;
  }
  async removeMetadata(m) {
    for (const h of m.headers) {
      for (const w of this.services.workspaceRegistry.list())
        if (w.sessionIds.includes(h.id)) await w.detachSession(h.id);
      await this.services.workspaceRegistry.unpinSession(h.id);
      await this.services.workspaceRegistry.unarchiveSession(h.id);
      await this.cache().delete(h.id);
      await this.store.digests.delete(h.id);
    }
    for (const id of Object.keys(m.map.edges)) await this.store.edges.delete(id);
    for (const id of Object.keys(m.map.cards)) await this.store.cards.delete(id);
    const global = this.store.global();
    const memory = { ...global.layoutMemory };
    for (const h of m.headers) delete memory[h.id];
    await this.store.setGlobal({ ...global, layoutMemory: memory });
  }
  async restoreMetadata(m) {
    for (const [id, value] of Object.entries(m.cache)) await this.cache().put(id, value);
    for (const membership of [...m.memberships].reverse()) {
      let w = this.services.workspaceRegistry.get(membership.workspaceId);
      if (w && w.path !== membership.path) fail("RESTORE_CONFLICT", "\u5DE5\u4F5C\u533A\u8EAB\u4EFD\u53D1\u751F\u53D8\u5316");
      w ??= await this.services.workspaceRegistry.create(membership.path, membership.title);
      await w.attachSession(membership.sessionId);
      if (membership.before && w.sessionIds.includes(membership.before))
        await w.insertSessionBefore(membership.sessionId, membership.before);
    }
    for (const id of m.archived) await this.services.workspaceRegistry.archiveSession(id);
    for (const id of [...m.pinned].reverse()) await this.services.workspaceRegistry.pinSession(id);
    for (const [id, c] of Object.entries(m.map.cards))
      if (!this.store.cards.get(id)) await this.store.cards.put(id, c);
    for (const [id, e] of Object.entries(m.map.edges)) {
      const edge = e;
      if (!this.store.edges.get(id) && this.store.cards.get(edge.fromCardId) && this.store.cards.get(edge.toCardId))
        await this.store.edges.put(id, e);
    }
    for (const [id, d] of Object.entries(m.map.digests))
      if (!this.store.digests.get(id)) await this.store.digests.put(id, d);
    const global = this.store.global();
    await this.store.setGlobal({
      ...global,
      layoutMemory: { ...m.map.memory, ...global.layoutMemory }
    });
  }
  publishAdded(m) {
    for (const h of m.headers) {
      const block = this.services.sessionProjectionCache.cachedSnapshot(h);
      const meta = block?.values.sessionListMetadata;
      this.publish("api-session/added", {
        sessionId: h.id,
        cwd: h.cwd,
        parentSessionId: h.parentSession,
        origin: h.origin,
        formatStatus: "current",
        agentAvailable: false,
        running: false,
        blank: meta?.blank ?? false,
        updatedAt: Math.max(meta?.lastPromptAt ?? 0, h.createdAt),
        ...block ? { projections: { kind: "cached", ...block } } : {}
      });
    }
  }
  publish(event, ...args) {
    try {
      this.services.emit(event, ...args);
    } catch (e) {
      this.services.logger?.warn(`[talk-map] notification failed: ${String(e)}`);
    }
  }
  async restore(ids) {
    return this.entriesOperation(ids, "restore");
  }
  async purge(ids) {
    return this.entriesOperation(ids, "purge");
  }
  async entriesOperation(ids, operation) {
    return this.serial(async () => {
      this.requireReady();
      const results = [];
      for (const id of [...new Set(ids)]) {
        const m = this.entries.get(id);
        const leases = [];
        try {
          entryId.parse(id);
          if (!m || m.state !== "trashed") fail("ENTRY_NOT_READY", "\u6761\u76EE\u4E0D\u5B58\u5728\u6216\u9700\u8981\u6062\u590D\u5904\u7406");
          await this.ensureAvailable(m.headers);
          for (const f of m.files) {
            const saved = await this.saved(f, m);
            if (!(await lstat2(saved)).isFile() || await hash(saved) !== f.hash)
              fail("FILE_CHANGED", "\u56DE\u6536\u7AD9\u6587\u4EF6\u6821\u9A8C\u5931\u8D25");
            if (await exists(await this.source(f, m)))
              fail("RESTORE_CONFLICT", "\u539F\u4F4D\u7F6E\u5DF2\u5B58\u5728\u4F1A\u8BDD\u6587\u4EF6");
          }
          for (const h of [...m.headers].sort((a, b) => a.id.localeCompare(b.id))) {
            if (await this.services.sessionPersistence.stat(h.id))
              fail("RESTORE_CONFLICT", "\u540C ID \u4F1A\u8BDD\u5DF2\u5B58\u5728");
            const dir = await this.inside(
              this.sessionsRoot,
              dirname(this.services.sessionPersistence.locate(h).path),
              true
            );
            leases.push(await this.services.sessionPersistence.acquireLease(h.id, void 0, dir));
            await this.inside(this.sessionsRoot, dir);
          }
          if (operation === "restore") {
            for (const member of m.memberships)
              if (!(await lstat2(member.path)).isDirectory())
                fail("RESTORE_CONFLICT", "\u539F\u5DE5\u4F5C\u533A\u76EE\u5F55\u4E0D\u53EF\u7528");
            for (const [cid, card] of Object.entries(m.map.cards))
              if (this.store.cards.get(cid) && JSON.stringify(this.store.cards.get(cid)) !== JSON.stringify(card))
                fail("RESTORE_CONFLICT", "\u5730\u56FE\u5361\u7247\u8EAB\u4EFD\u53D1\u751F\u53D8\u5316");
          }
          m.operation = operation;
          m.state = operation === "restore" ? "restoring" : "purging";
          delete m.error;
          await this.save(m);
          if (operation === "restore") {
            for (const f of m.files)
              await this.move(await this.saved(f, m), await this.source(f, m), f.hash);
            await this.restoreMetadata(m);
            m.state = "restored";
            await this.save(m);
            m.headers.forEach((h) => this.blocked.delete(h.id));
            this.publishAdded(m);
            await this.discardEntry(m);
          } else await this.finishPurge(m);
          results.push(this.result(id, m, operation === "restore" ? "restored" : "purged"));
        } catch (error) {
          if (m && ["restoring", "purging"].includes(m.state))
            try {
              await this.recover(m, true);
            } catch (e) {
              m.state = "failed";
              m.error = String(e);
              await this.save(m);
            }
          results.push(this.result(id, m, "failed", error));
        } finally {
          for (const lease of leases.reverse()) await lease.release();
          if (m && !this.entries.has(m.entryId) && operation === "purge") await this.pruneSources(m.headers);
        }
      }
      return results;
    });
  }
  async finishPurge(m) {
    for (const f of m.files) {
      const saved = await this.saved(f, m);
      if (await exists(saved)) {
        if (!(await lstat2(saved)).isFile() || await hash(saved) !== f.hash)
          fail("FILE_CHANGED", "\u56DE\u6536\u7AD9\u6587\u4EF6\u6821\u9A8C\u5931\u8D25");
        await unlink(saved);
      }
    }
    for (const h of m.headers) this.purged.add(h.id);
    const target = await this.inside(
      await realpath2(this.home),
      join2(dirname(this.root), "purged.json"),
      true
    );
    const temp = await this.inside(
      await realpath2(this.home),
      join2(dirname(this.root), "purged.tmp"),
      true
    );
    const fd = await open(temp, "w", 384);
    try {
      await fd.writeFile(JSON.stringify([...this.purged]));
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temp, target);
    await this.discardEntry(m);
    m.headers.forEach((h) => this.blocked.delete(h.id));
  }
  async discardEntry(m) {
    const manifest = await this.inside(this.root, join2(this.entryDir(m.entryId), "manifest.json"));
    for (const id of new Set(m.files.map((f) => f.sessionId))) {
      const dir = await this.inside(this.root, join2(this.entryDir(m.entryId), "logs", id), true);
      if (await exists(dir)) await rmdir(dir);
    }
    const logs = await this.inside(this.root, join2(this.entryDir(m.entryId), "logs"), true);
    if (await exists(logs)) await rmdir(logs);
    await unlink(manifest);
    await rmdir(this.entryDir(m.entryId));
    this.entries.delete(m.entryId);
  }
  async recover(m, locked = false) {
    const leases = [];
    try {
      await this.ensureAvailable(m.headers);
      if (!locked)
        for (const h of [...m.headers].sort((a, b) => a.id.localeCompare(b.id))) {
          const dir = await this.inside(
            this.sessionsRoot,
            dirname(this.services.sessionPersistence.locate(h).path),
            true
          );
          leases.push(await this.services.sessionPersistence.acquireLease(h.id, void 0, dir));
          await this.inside(this.sessionsRoot, dir);
        }
      await this.recoverFiles(m);
    } finally {
      for (const lease of leases.reverse()) await lease.release();
    }
  }
  async recoverFiles(m) {
    if (m.operation === "purge") {
      await this.ensureAvailable(m.headers);
      await this.finishPurge(m);
      return;
    }
    for (const f of m.files) {
      const source = await this.source(f, m), saved = await this.saved(f, m);
      const from = m.operation === "trash" ? saved : source, to = m.operation === "trash" ? source : saved;
      if (await exists(from)) {
        if (await exists(to)) {
          if (await hash(from) !== f.hash || await hash(to) !== f.hash)
            fail("RESTORE_CONFLICT", "\u6062\u590D\u6587\u4EF6\u51B2\u7A81");
          await unlink(from);
        } else await this.move(from, to, f.hash);
      } else if (!await exists(to) || await hash(to) !== f.hash)
        fail("FILE_CHANGED", "\u6062\u590D\u6240\u9700\u6587\u4EF6\u7F3A\u5931");
    }
    if (m.operation === "trash") {
      await this.restoreMetadata(m);
      m.state = "restored";
      await this.save(m);
      m.headers.forEach((h) => this.blocked.delete(h.id));
      this.publishAdded(m);
      await this.discardEntry(m);
    } else {
      await this.removeMetadata(m);
      m.state = "trashed";
      await this.save(m);
    }
  }
};

// src/host/routes.ts
var MAX_BODY_BYTES = 1024 * 1024;
function textOfBlocks2(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((block) => typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
}
function isHumanMessage(source) {
  const kind = source?.kind;
  return kind === void 0 || kind === "user";
}
function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(payload);
}
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (origin === void 0) return true;
  const host = request.headers.host;
  if (host === void 0) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? void 0 : JSON.parse(text);
}
function tableToRecord(table) {
  const out = {};
  for (const [key, value] of table.entries()) out[key] = value;
  return out;
}
var upsertCardsBody = z3.object({
  cards: z3.record(z3.string(), cardSchema)
});
var upsertEdgesBody = z3.object({
  edges: z3.record(z3.string(), edgeSchema)
});
var deleteCardsBody = z3.object({
  ids: z3.array(z3.string())
});
var setGlobalBody = z3.object({
  global: globalSchema
});
var spawnBody = z3.object({
  parents: z3.array(z3.object({
    cardId: z3.string(),
    sessionId: z3.string(),
    text: z3.string().min(1)
  })).min(1),
  boardId: z3.string(),
  x: z3.number(),
  y: z3.number(),
  wsOverride: z3.string().optional()
});
var refreshDigestBody = z3.object({
  sessionId: z3.string()
});
var injectBody = z3.object({
  sessionId: z3.string(),
  parents: z3.array(z3.object({
    sessionId: z3.string(),
    text: z3.string().min(1)
  })).min(1)
});
var ensureDirBody = z3.object({
  path: z3.string().min(1)
});
function mountTalkMapRoutes(services, storeReady, runtime) {
  const sseClients = /* @__PURE__ */ new Set();
  const offChanged = services.on("domain/changed", (...args) => {
    const change = args[0];
    if (change.domain !== DOMAIN_NAME) return;
    const frame = `event: change
data: ${JSON.stringify(change)}

`;
    for (const client of sseClients) client.write(frame);
  });
  const ping = setInterval(() => {
    for (const client of sseClients) client.write(": ping\n\n");
  }, 25e3);
  ping.unref?.();
  const unregister = services.webServer.register({
    kind: "prefix",
    // NOTE: webserver prefix p matches `p` and `p/<anything>` — no trailing slash.
    path: "/talk-map",
    handler: async (request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const route = `${request.method ?? "GET"} ${url.pathname}`;
      try {
        if (route === "GET /talk-map/state") {
          const store = await storeReady;
          sendJson(response, 200, {
            boards: tableToRecord(store.boards),
            cards: tableToRecord(store.cards),
            edges: tableToRecord(store.edges),
            digests: tableToRecord(store.digests),
            global: store.global()
          });
          return;
        }
        if (route === "GET /talk-map/storage") {
          if (!runtime.trash) {
            sendJson(response, 503, { code: "SERVICE_UNAVAILABLE", error: "\u5B58\u50A8\u670D\u52A1\u4E0D\u53EF\u7528" });
            return;
          }
          sendJson(response, 200, await runtime.trash.storage());
          return;
        }
        if (route === "GET /talk-map/trash") {
          if (!runtime.trash) {
            sendJson(response, 503, { code: "SERVICE_UNAVAILABLE", error: "\u56DE\u6536\u7AD9\u670D\u52A1\u4E0D\u53EF\u7528" });
            return;
          }
          sendJson(response, 200, { entries: await runtime.trash.listing(), capabilities: { stopActivity: true } });
          return;
        }
        if (route === "GET /talk-map/defaults") {
          let model = null;
          let preset = null;
          try {
            model = runtime.modelDefault?.() ?? null;
          } catch {
          }
          try {
            preset = runtime.presetDefault?.() ?? null;
          } catch {
          }
          sendJson(response, 200, { model, preset });
          return;
        }
        if (route === "GET /talk-map/events") {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "connection": "keep-alive"
          });
          response.write(": connected\n\n");
          sseClients.add(response);
          request.on("close", () => {
            sseClients.delete(response);
          });
          return;
        }
        if (request.method === "POST" && !sameOrigin(request)) {
          sendJson(response, 403, { error: "cross-origin request refused" });
          return;
        }
        if (/^POST \/talk-map\/sessions\/(trash|restore|purge)$/.test(route)) {
          if (!runtime.trash) {
            sendJson(response, 503, { code: "SERVICE_UNAVAILABLE", error: "\u56DE\u6536\u7AD9\u670D\u52A1\u4E0D\u53EF\u7528" });
            return;
          }
          const action = url.pathname.split("/").at(-1);
          const schema = action === "trash" ? z3.object({ sessionIds: z3.array(safeId).min(1).max(200), stopActivity: z3.boolean().optional() }).strict() : z3.object({ entryIds: z3.array(z3.string().uuid()).min(1).max(200) }).strict();
          const body = schema.parse(await readJsonBody(request));
          const ids = "sessionIds" in body ? body.sessionIds : body.entryIds;
          sendJson(response, 200, { results: await (action === "trash" ? runtime.trash.trash(ids, { stopActivity: "stopActivity" in body && body.stopActivity === true }) : runtime.trash[action](ids)) });
          return;
        }
        if (route === "POST /talk-map/cards/upsert") {
          const store = await storeReady;
          const body = upsertCardsBody.parse(await readJsonBody(request));
          const write = async () => {
            for (const [id, card] of Object.entries(body.cards)) {
              await store.cards.put(id, card);
              const digest = store.digests.get(card.sessionId);
              if (digest === void 0 || digest.summary === "") {
                runtime.digest?.schedule(card.sessionId);
              }
            }
          };
          if (runtime.trash) await runtime.trash.writeActive(Object.values(body.cards).map((c) => c.sessionId), write);
          else await write();
          sendJson(response, 200, { ok: true, count: Object.keys(body.cards).length });
          return;
        }
        if (route === "POST /talk-map/edges/upsert") {
          const store = await storeReady;
          const body = upsertEdgesBody.parse(await readJsonBody(request));
          const write = async () => {
            for (const [id, edge] of Object.entries(body.edges)) {
              if (!store.cards.get(edge.fromCardId) || !store.cards.get(edge.toCardId)) throw new Error("edge endpoints unavailable");
              await store.edges.put(id, edge);
            }
          };
          if (runtime.trash) await runtime.trash.serial(write);
          else await write();
          sendJson(response, 200, { ok: true, count: Object.keys(body.edges).length });
          return;
        }
        if (route === "POST /talk-map/cards/delete") {
          const store = await storeReady;
          const body = deleteCardsBody.parse(await readJsonBody(request));
          let removed = 0;
          for (const id of body.ids) {
            if (await store.cards.delete(id)) removed += 1;
          }
          for (const [edgeId, edge] of [...store.edges.entries()]) {
            if (body.ids.includes(edge.fromCardId) || body.ids.includes(edge.toCardId)) {
              await store.edges.delete(edgeId);
            }
          }
          sendJson(response, 200, { ok: true, removed });
          return;
        }
        if (route === "POST /talk-map/edges/delete") {
          const store = await storeReady;
          const body = deleteCardsBody.parse(await readJsonBody(request));
          let removed = 0;
          for (const id of body.ids) {
            if (await store.edges.delete(id)) removed += 1;
          }
          sendJson(response, 200, { ok: true, removed });
          return;
        }
        if (route === "POST /talk-map/global") {
          const store = await storeReady;
          const body = setGlobalBody.parse(await readJsonBody(request));
          const write = async () => {
            const memory = { ...body.global.layoutMemory };
            for (const id of Object.keys(memory)) if (runtime.trash?.isBlocked(id)) delete memory[id];
            await store.setGlobal({ ...body.global, layoutMemory: memory });
          };
          if (runtime.trash) await runtime.trash.serial(write);
          else await write();
          sendJson(response, 200, { ok: true });
          return;
        }
        if (route === "POST /talk-map/inject") {
          if (runtime.spawner === void 0) {
            sendJson(response, 503, { error: "spawn layer unavailable (agents service missing)" });
            return;
          }
          const body = injectBody.parse(await readJsonBody(request));
          try {
            runtime.spawner.injectInto(body.sessionId, body.parents);
          } catch (error) {
            if (error instanceof SessionNotLiveError) {
              sendJson(response, 409, { error: String(error), code: "session-not-live" });
              return;
            }
            throw error;
          }
          sendJson(response, 200, { ok: true });
          return;
        }
        if (route === "POST /talk-map/spawn") {
          if (runtime.spawner === void 0) {
            sendJson(response, 503, { error: "spawn layer unavailable (agents service missing)" });
            return;
          }
          const body = spawnBody.parse(await readJsonBody(request));
          const result = await runtime.spawner.spawn(body);
          sendJson(response, 200, result);
          return;
        }
        if (route === "POST /talk-map/fs/ensure-dir") {
          const body = ensureDirBody.parse(await readJsonBody(request));
          const target = resolvePath(body.path);
          const home = homedir();
          if (target !== home && !target.startsWith(home + sep)) {
            sendJson(response, 400, { error: "path must be inside the home directory" });
            return;
          }
          await mkdir2(target, { recursive: true });
          sendJson(response, 200, { ok: true, path: target });
          return;
        }
        if (route === "POST /talk-map/search") {
          const body = await readJsonBody(request);
          const query = typeof body?.query === "string" ? body.query.trim() : "";
          const search = runtime.search;
          if (query === "" || search === void 0) {
            sendJson(response, 200, { items: [], hasMore: false });
            return;
          }
          try {
            const page = await search(query);
            sendJson(response, 200, { items: page?.items ?? [], hasMore: page?.hasMore === true });
          } catch (error) {
            sendJson(response, 500, { error: String(error?.message ?? error) });
          }
          return;
        }
        if (route === "POST /talk-map/search-context") {
          const body = await readJsonBody(request);
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
          const seq = typeof body?.seq === "number" ? body.seq : null;
          const query = typeof body?.query === "string" ? body.query : "";
          const read = runtime.searchContext;
          if (sessionId === "" || seq === null || read === void 0) {
            sendJson(response, 200, { lines: [] });
            return;
          }
          try {
            sendJson(response, 200, await read(sessionId, seq, query));
          } catch (error) {
            sendJson(response, 200, { lines: [], error: String(error?.message ?? error) });
          }
          return;
        }
        if (route === "POST /talk-map/last-user") {
          const body = await readJsonBody(request);
          const ids = Array.isArray(body.sessionIds) ? body.sessionIds.filter((id) => typeof id === "string").slice(0, 200) : [];
          const texts = {};
          const query = runtime.sessionQuery;
          if (query !== void 0) {
            await Promise.all(ids.map(async (sessionId) => {
              try {
                const surface = await query.readSurface(sessionId);
                let text = "";
                for (const raw of surface.events) {
                  const event = raw;
                  if (event.type !== "user/message") continue;
                  if (!isHumanMessage(event.data?.source)) continue;
                  const body2 = textOfBlocks2(event.data?.content);
                  if (body2 !== "") text = body2;
                }
                if (text !== "") texts[sessionId] = text.length > 240 ? text.slice(0, 240) : text;
              } catch {
              }
            }));
          }
          sendJson(response, 200, { texts });
          return;
        }
        if (route === "POST /talk-map/digest/refresh") {
          if (runtime.digest === void 0) {
            sendJson(response, 503, { error: "digest layer unavailable (llm service missing)" });
            return;
          }
          const body = refreshDigestBody.parse(await readJsonBody(request));
          const digest = await runtime.digest.refresh(body.sessionId);
          sendJson(response, 200, { sessionId: body.sessionId, digest });
          return;
        }
        sendJson(response, 404, { error: `no such route: ${route}` });
      } catch (error) {
        services.logger?.warn(`[dsh-talk-map] ${route} failed: ${String(error)}`);
        if (!response.headersSent) {
          const code = error.code;
          sendJson(response, code === "SERVICE_UNAVAILABLE" ? 503 : 400, { code, error: String(error) });
        } else {
          response.end();
        }
      }
    }
  });
  return () => {
    clearInterval(ping);
    offChanged();
    for (const client of sseClients) client.end();
    sseClients.clear();
    unregister();
  };
}

// src/index.ts
import { homedir as homedir2 } from "node:os";
import { resolve as resolve3 } from "node:path";
var name = "dsh-talk-map";
function apply(ctx) {
  const runtime = {};
  let resolveStore;
  let rejectStore;
  const storeReady = new Promise((resolve4, reject) => {
    resolveStore = resolve4;
    rejectStore = reject;
  });
  storeReady.catch(() => {
  });
  ctx.inject(["storageDomain", "webServer"], (injected) => {
    const services = injected;
    services.effect(() => {
      let disposed = false;
      let store;
      openTalkMapStore(services.storageDomain).then((opened) => {
        if (disposed) {
          void opened.domain.close();
          return;
        }
        store = opened;
        resolveStore(opened);
        services.logger?.info?.("[dsh-talk-map] storage domain open, routes live at /talk-map/");
      }).catch((error) => {
        services.logger?.warn(`[dsh-talk-map] storage domain failed to open: ${String(error)}`);
        rejectStore(error);
      });
      const unmountRoutes = mountTalkMapRoutes(services, storeReady, runtime);
      return () => {
        disposed = true;
        unmountRoutes();
        void store?.domain.close();
      };
    }, "dsh-talk-map: domain + routes");
  });
  ctx.inject(["sessions", "sessionQuery", "sessionController", "llm", "agentDefaultModel"], (injected) => {
    const services = injected;
    services.effect(() => {
      const pipeline = new DigestPipeline(
        services,
        storeReady,
        void 0,
        void 0,
        (id, write) => runtime.trash ? runtime.trash.writeActive([id], write) : write()
      );
      const stop = pipeline.start();
      runtime.digest = pipeline;
      runtime.search = async (query) => {
        const corpus = runtime.sessionQuery;
        if (corpus === void 0) throw new Error("sessionQuery unavailable");
        const page = await corpus.searchSessions({ query, limit: 20 }, { signal: new AbortController().signal });
        const items = (page.items ?? []).map((hit) => ({ sessionId: hit.header?.id ?? "", snippet: hit.bestMatch?.snippet ?? "" })).filter((item) => item.sessionId !== "");
        return { items, hasMore: page.nextCursor !== void 0 };
      };
      void storeReady.then((store) => {
        if (runtime.digest !== pipeline) return;
        const missing = [...new Set([...store.cards.entries()].map(([, card]) => card.sessionId))].filter((sessionId) => {
          const digest = store.digests.get(sessionId);
          return digest === void 0 || digest.summary === "";
        });
        pipeline.backfill(missing);
      }).catch(() => void 0);
      return () => {
        stop();
        if (runtime.digest === pipeline) delete runtime.digest;
      };
    }, "dsh-talk-map: digest pipeline");
  });
  ctx.inject(["agents", "sessions", "agentLoop", "sessionPersistence"], (injected) => {
    const services = injected;
    services.effect(() => {
      const lifecycle = installSessionLifecycle(services);
      return services.on("agent/pre-step", ({ agent }, next) => lifecycle?.blocks(agent.id) ? Promise.resolve({ kind: "reject" }) : next());
    }, "dsh-talk-map: native session lifecycle");
  });
  ctx.inject(["storageDomain", "sessions", "agents", "sessionPersistence", "sessionProjectionCache", "workspaceRegistry"], (injected) => {
    const services = injected;
    services.effect(() => {
      let disposed = false;
      let trash;
      void storeReady.then(async (store) => {
        if (disposed) return;
        trash = new SessionTrash(services, store, resolve3(process.env.DSH_HOME ?? resolve3(homedir2(), ".dsh")));
        runtime.trash = trash;
        await trash.initialize();
        if (disposed) await trash.close();
      }).catch((error) => services.logger?.warn(`[dsh-talk-map] trash unavailable: ${String(error)}`));
      return async () => {
        disposed = true;
        await trash?.close();
      };
    }, "dsh-talk-map: session trash");
  });
  ctx.inject(["agentDefaultModel"], (injected) => {
    const services = injected;
    services.effect(() => {
      runtime.modelDefault = () => services.agentDefaultModel.currentSelection();
      return () => {
        delete runtime.modelDefault;
      };
    }, "dsh-talk-map: model default");
  });
  ctx.inject(["sessionQuery"], (injected) => {
    const services = injected;
    services.effect(() => {
      runtime.sessionQuery = services.sessionQuery;
      return () => {
        if (runtime.sessionQuery === services.sessionQuery) delete runtime.sessionQuery;
      };
    }, "dsh-talk-map: session query");
  });
  ctx.inject(["agentPresets"], (injected) => {
    const services = injected;
    services.effect(() => {
      runtime.presetDefault = () => services.agentPresets.defaultId;
      return () => {
        delete runtime.presetDefault;
      };
    }, "dsh-talk-map: preset default");
  });
  ctx.inject(["agents", "sessionQuery", "workspaceRegistry"], (injected) => {
    const services = injected;
    services.effect(() => {
      const spawner = new Spawner(services, storeReady);
      runtime.spawner = spawner;
      return () => {
        if (runtime.spawner === spawner) delete runtime.spawner;
      };
    }, "dsh-talk-map: spawner");
  });
}
export {
  apply,
  name
};
