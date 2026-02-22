/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const VOICE_TTS_DEFAULT = process.env.VOICE_TTS_DEFAULT || "openai";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "nova";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const TRUSTED_BOT_IDS = (process.env.TRUSTED_BOT_IDS || "").split(",").filter(Boolean);
let consecutiveBotMessages = 0;
const MAX_BOT_CHAIN = 3;

// Internal HTTP bridge for bot-to-bot communication
// (Telegram doesn't deliver bot messages to other bots — this works around that)
const RELAY_PORT = parseInt(process.env.RELAY_PORT || "0"); // 0 = disabled
const SIBLING_BOT_URLS = (process.env.SIBLING_BOT_URLS || "").split(",").filter(Boolean);

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// INTERNAL HTTP BRIDGE (bot-to-bot communication)
// ============================================================
// Telegram does not deliver bot messages to other bots. This bridge
// lets each bot POST its replies to sibling bots' HTTP endpoints,
// which process them as if they arrived via Telegram.

async function notifySiblings(senderName: string, text: string, chatId: number): Promise<void> {
  if (SIBLING_BOT_URLS.length === 0) return;
  for (const url of SIBLING_BOT_URLS) {
    fetch(`${url}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderName, text, chatId }),
    }).catch((err) => console.error(`Bridge notify error (${url}):`, err));
  }
}

async function processSiblingMessage(
  senderName: string,
  text: string,
  chatId: number
): Promise<void> {
  const myName = (process.env.BOT_NAME || "").toLowerCase();
  const myNameCore = myName.startsWith("@") ? myName.slice(1) : myName;
  if (!myNameCore || !text.toLowerCase().includes(myNameCore)) return;
  if (consecutiveBotMessages >= MAX_BOT_CHAIN) {
    console.log(`Bot chain limit (${MAX_BOT_CHAIN}) reached — dropping message from ${senderName}`);
    return;
  }
  consecutiveBotMessages++;

  console.log(`Bridge: ${senderName} → ${process.env.BOT_NAME}: "${text.substring(0, 60)}"`);

  const enrichedPrompt = buildPrompt(text, undefined, undefined, senderName);
  const rawResponse = await callClaude(enrichedPrompt, { resume: true });
  const response = await processMemoryIntents(supabase, rawResponse);

  await saveMessage("assistant", response);

  try {
    await bot.api.sendMessage(chatId, response);
    await notifySiblings(process.env.BOT_NAME || "Bot", response, chatId);
  } catch (error) {
    console.error("Bridge send error:", error);
  }
}

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  const isFromBot = ctx.from?.is_bot === true;
  const isFromTrustedBot = isFromBot && TRUSTED_BOT_IDS.includes(userId || "");

  // Reset bot chain counter on any human message
  if (!isFromBot) consecutiveBotMessages = 0;

  // Only allow authorized user or trusted sibling bots
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID && !isFromTrustedBot) {
    return;
  }

  // In group chats, apply mention/name filtering
  const chatType = ctx.chat?.type;
  if (chatType === "group" || chatType === "supergroup") {
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const entities = ctx.message && "entities" in ctx.message ? ctx.message.entities ?? [] : [];
    const botUsername = ctx.me.username;
    const botName = (process.env.BOT_NAME || "").toLowerCase();

    const mentioned = entities.some(
      (e) =>
        e.type === "mention" &&
        text.substring(e.offset, e.offset + e.length) === `@${botUsername}`
    );

    if (isFromTrustedBot) {
      // Bot-to-bot: respond if named anywhere in message, subject to depth limit
      const namedByBot = botName && text.toLowerCase().includes(botName);
      if (!namedByBot || consecutiveBotMessages >= MAX_BOT_CHAIN) return;
      consecutiveBotMessages++;
    } else {
      // Human: respond if named at start or @mentioned
      const namedDirectly = botName && text.toLowerCase().startsWith(botName);
      if (!mentioned && !namedDirectly) return;
    }
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--model", "claude-haiku-4-5-20251001");
  args.push("--output-format", "text");
  args.push("--dangerously-skip-permissions");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);
  console.log(`Command: ${args.join(" ").substring(0, 100)}`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
        // Pass through any env vars Claude might need
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude stdout:", output);
      console.error("Claude stderr:", stderr);
      console.error("Claude exit code:", exitCode);
      return `Error: ${stderr || output || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// TEXT-TO-SPEECH (HYBRID: OpenAI default, ElevenLabs premium)
// ============================================================

async function textToSpeechOpenAI(text: string): Promise<Buffer | null> {
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return null;

  const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice: OPENAI_TTS_VOICE,
        input: text,
      }),
    });
    if (!response.ok) {
      console.error("OpenAI TTS error:", await response.text());
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error("OpenAI TTS error:", error);
    return null;
  }
}

async function textToSpeechElevenLabs(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY) return null;
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_monolingual_v1",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );
    if (!response.ok) {
      console.error("ElevenLabs error:", await response.text());
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error("ElevenLabs TTS error:", error);
    return null;
  }
}

async function textToSpeech(
  text: string,
  _usePremium: boolean = false
): Promise<Buffer | null> {
  console.log("Using ElevenLabs/Klara voice");
  return await textToSpeechElevenLabs(text);
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

  await saveMessage("user", text);

  // Gather context: semantic search + facts/goals
  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(supabase, text),
    getMemoryContext(supabase),
  ]);

  const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext);
  const rawResponse = await callClaude(enrichedPrompt, { resume: true });

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse);

  await saveMessage("assistant", response);
  await sendResponse(ctx, response);

  // Notify sibling bots if this is a group chat — they can't see our Telegram messages
  if ((ctx.chat.type === "group" || ctx.chat.type === "supergroup") && SIBLING_BOT_URLS.length > 0) {
    notifySiblings(process.env.BOT_NAME || "Bot", response, ctx.chat.id).catch(console.error);
  }
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);

    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext
    );
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", claudeResponse);

    const audio = await textToSpeech(claudeResponse);
    if (audio) {
      await ctx.replyWithVoice(new InputFile(audio, "response.ogg"));
    } else {
      await sendResponse(ctx, claudeResponse);
    }
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  fromName?: string  // set when message comes from a sibling bot via the HTTP bridge
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational. Never use stage directions or asterisk actions (like *pauses* or *tilts head*). Respond only in plain prose.",
  ];

  if (fromName) {
    parts.push(`You are in a group conversation. ${fromName} is speaking to you.`);
  } else if (USER_NAME) {
    parts.push(`You are speaking with ${USER_NAME}.`);
  }
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

// ============================================================
// START BRIDGE SERVER (if port configured)
// ============================================================

if (RELAY_PORT > 0) {
  Bun.serve({
    port: RELAY_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/message") {
        try {
          const body = (await req.json()) as {
            senderName: string;
            text: string;
            chatId: number;
          };
          // Process async — respond immediately so the sender doesn't block
          processSiblingMessage(body.senderName, body.text, body.chatId).catch(console.error);
          return new Response("ok", { status: 200 });
        } catch {
          return new Response("bad request", { status: 400 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Bridge server listening on port ${RELAY_PORT}`);
  console.log(`Sibling bots: ${SIBLING_BOT_URLS.join(", ") || "none"}`);
}

// ============================================================
// START BOT
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
