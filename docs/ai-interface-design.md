# Worldscope: AI Interface & UX Design

## Core Principle

The globe is the primary interface. Everything else is secondary and should get out of the way when not needed. No permanent toolbars, no button-heavy panels, no mode-switching chrome. Capabilities are expressed through conversation and direct manipulation, not widgets.

## Input Methods

### Text (primary)
A command bar at the bottom edge of the screen, always one keystroke away (Tab or /). Supports natural language ("show wind over the Atlantic") and structured commands ("/load flood-sim"). Autocompletes against the feature registry so users can discover available capabilities without documentation.

### Voice (optional)
Push-to-talk via keyboard (V key) or gamepad button. Uses browser speech recognition or a dedicated STT service. Visual feedback: a small waveform indicator near the command bar while listening. Voice is ideal when hands are on the gamepad or when exploring hands-free. Disabled by default, toggled in settings. No always-listening mode (privacy, and nobody wants to accidentally trigger commands).

### Direct Manipulation
Mouse, keyboard, and gamepad navigation of the globe itself. Click-to-query: tap a location and the AI provides context ("You're looking at the Saharan heat low, surface temps around 52C today"). Drag-to-select for region-based queries. These are implicit AI interactions that don't require the chat panel.

## Chat Panel: Three States

The chat surface is a single component with three display states. A keyboard shortcut (Escape or backtick) cycles through them. The panel can also be dragged to resize continuously.

### Minimized (default)
- Just the command input bar, pinned to the bottom edge
- Slim, translucent, maybe 40px tall
- Shows a one-line AI response that fades after 5 seconds
- Example: user types "show temperature," AI loads the layer, bar briefly shows "Showing ERA5 2m temperature, latest available"
- The globe is fully visible, completely unobstructed

### Peek (quick reference)
- Bottom panel expands to ~20-25% of screen height
- Shows the last 3-5 messages with the command bar at the bottom
- Enough to follow a short back-and-forth ("Which year?" / "2024" / "Got it, loading...")
- Semi-transparent background so the globe is still partially visible beneath
- Useful during multi-step interactions where the AI needs clarification

### Full (research mode)
- Left sidebar, roughly 35-40% of screen width
- Complete scrolling chat history with rich content rendering
- Supports markdown, LaTeX equations, inline charts, data tables, code blocks
- This is the mode for deep discussion: explaining atmospheric dynamics, reviewing model outputs, comparing datasets, showing formulas
- The globe occupies the remaining right portion and stays fully interactive
- Interactive widgets (sliders, dropdowns, color pickers) can appear inline in AI responses as an alternative to typing parameters

### Behavior rules
- The AI adapts its response length to the current panel state. Minimized gets terse confirmations. Full gets detailed explanations with citations and equations.
- Switching states never loses context. Expanding from minimized to full reveals the history that was always there.
- The panel remembers its last state per session but always starts minimized on launch.

## Audio Design

Sound is a first-class part of the experience, not an afterthought. It makes the app feel like a living system rather than a static tool.

### Sound Effects
- Ambient: altitude-dependent hum or wind. Subtle, almost subliminal. Changes character from "space silence" at orbital altitude to "wind" near the surface.
- Interaction feedback: soft clicks on selection, a gentle tone when a data layer finishes loading, a subtle whoosh on fast camera moves.
- Data sonification (future): map a variable to pitch or rhythm. Hear temperature gradients as you fly over them.
- All effects should be designed to feel natural and non-intrusive. Think "well-designed game" not "PowerPoint transition sounds."

### Background Music
- Ambient, generative-style music that responds to context. Calm and expansive at orbital view, more textured and detailed near the surface.
- Inspired by: Minecraft's ambient soundtrack, No Man's Sky, Google Earth VR.
- Music is off by default. Toggled via command ("play music") or settings.

### Volume Controls
Three independent channels, each with its own volume slider (accessible via settings or voice command):
1. **Effects** (interaction sounds, loading indicators)
2. **Ambient** (environmental audio, data sonification)
3. **Music** (background soundtrack)

Plus a global mute toggle (M key) that silences everything instantly. Unmuting restores previous levels.

### Voice Output (TTS)
Optional text-to-speech for AI responses. Useful in hands-free / gamepad exploration mode. The AI "narrates" what you're seeing as you fly around. Off by default. When enabled, the AI keeps responses short and spoken-word-friendly (no equations or tables via voice).

## Feature Integration Model

Features don't add UI. They register capabilities.

When a feature module is loaded (say, flood simulation), it registers:
- Natural language intents it can handle ("simulate flooding," "set water level," "show flood risk")
- Parameters it accepts (water level in meters, region, time period)
- Visualization outputs it produces (water overlay, depth colormap, affected area polygons)
- Any inline widgets it wants to offer in full-panel mode (a water level slider, a scenario picker)

The AI intent router matches user requests to registered features. If no feature matches, the AI says so and suggests what's available. If a feature is unloaded, its intents simply stop matching. No orphaned buttons, no grayed-out menus.

## Command Registry

Commands live in three layers. Core commands (navigation, view controls, audio, settings, help) are always available and ship with the app. Feature commands are registered dynamically when a module loads and disappear when it unloads. User commands (macros, saved workflows) are defined by the user at runtime.

All three layers feed into the same registry, which is the single source of truth for "what can this app do right now." The intent router matches against it, autocomplete draws from it, and "what can you do?" summarizes it. Each entry declares its intent patterns, parameters, handler, and which module owns it.

The registry is append/remove only. Loading a feature appends its commands. Unloading removes them. No central manifest to maintain.

## Discoverability

Without visible buttons, users need other ways to learn what's possible:
- **Autocomplete**: typing in the command bar suggests capabilities ("show..." expands to available data layers)
- **"What can you do?"**: the AI lists currently loaded features and example commands
- **Context hints**: when hovering over a region, a subtle tooltip suggests relevant queries ("Try: 'climate projection for this area'")
- **Onboarding flow**: first launch walks through the basics (navigation, command bar, panel states) with a few guided interactions

## Accessibility

- All panel states are keyboard-navigable
- Screen reader support for chat content and AI responses
- High-contrast mode for the command bar and response text over the globe
- Sound effects are never the only feedback channel (always paired with visual)
- Voice input and TTS provide an alternative to text for motor-impaired users

## AI Provider Architecture

The app never calls a specific AI model directly. All inference goes through a unified provider interface, and a router decides which backend handles each request based on task complexity, hardware, latency requirements, user preference, and network availability.

### Provider Interface

Every AI backend implements the same contract:

```
AIProvider:
  chat(messages, options) → async stream of tokens
  classify(text, intents) → intent + confidence + extracted params
  embed(text) → vector (for RAG similarity search)
  available() → boolean (can this provider handle requests right now?)
```

### Available Providers

**ClaudeProvider** (cloud, Anthropic API): Opus for deep scientific reasoning, Sonnet for general conversation, Haiku for fast classification. Best knowledge quality, requires network. Cost managed via smart routing (don't send simple commands to Opus).

**OllamaProvider** (local, via Ollama daemon): Llama, Mistral, Phi, or whatever the user has pulled. Good for mid-complexity tasks on machines with a decent GPU. Sub-second latency, no network dependency, no API cost. Optional dependency.

**LlamaCppProvider** (local, direct inference): Maximum performance for users who want to run models without the Ollama layer. Useful for embedded/kiosk deployments.

**OpenAIProvider** (cloud, OpenAI API): Compatibility option for users who prefer GPT models or have existing API keys.

**NIMProvider** (cloud or on-prem, NVIDIA NIM): For NVIDIA deployments with NIM endpoints. Particularly relevant for Earth-2 model inference where the AI backend might also be orchestrating GPU workloads.

**BrowserProvider** (in-browser, WebLLM/ONNX): Tiny models (1-3B) running directly in the browser via WebGPU or WASM. No server, no network. Limited capability but instant for intent classification and autocomplete.

### Routing Strategy

The router processes every user input through a priority chain. Each tier either handles the request or passes it down:

**Tier 0: Pattern matching (instant, no model needed)**
Regex and keyword rules catch unambiguous commands: "go to [place]", "show [variable]", "zoom in", "toggle [layer]", "mute", "reset view". Handles 60-70% of interactive commands with zero latency. Works everywhere, even offline on a phone.

**Tier 1: Local fast classifier (under 50ms)**
A small model (BrowserProvider or OllamaProvider with a tiny model) classifies intent and extracts parameters for commands that are slightly ambiguous. "Pull up the winds" maps to the wind layer. "What's the temperature here?" maps to a point query with the current camera location. This tier handles another 20% of requests.

**Tier 2: Local conversational model (under 2s)**
For users with a GPU and Ollama running, a 7-13B model handles moderate conversations: summarizing visible data, answering factual questions from cached context, explaining what's on screen. Quality is good but not expert-level.

**Tier 3: Cloud reasoning model (2-10s)**
Claude Opus/Sonnet for everything that needs deep expertise: scientific explanations, complex multi-step analysis, interpreting ambiguous or novel requests, generating detailed reports. This is where the earth science knowledge lives.

### Hardware Profiles

The router adapts its strategy based on detected hardware:

**Laptop (no discrete GPU, no Ollama):** Tier 0 + Tier 1 (BrowserProvider for classification) + Tier 3 (cloud for everything else). Fast and responsive for navigation, cloud-dependent for conversation. This is the baseline experience and it's still good.

**Laptop with GPU (Ollama available):** All four tiers. Local model handles most interactions, cloud only for deep reasoning. Can work offline with reduced capability (no Tier 3).

**Workstation / beefy GPU setup:** All four tiers, but Tier 2 uses a larger local model (30-70B) that can handle most scientific questions without cloud. Cloud becomes a fallback rather than the default. Lowest latency, lowest cost.

**Kiosk / demo mode:** Tier 0 + Tier 1 only, pre-cached responses for common queries. No network, no local model server. Everything is instant but capability is limited to what's been pre-programmed.

### Dynamic Context (RAG)

Each feature module can register context documents that get injected into AI prompts when that feature is active:

- Model cards (what the data source is, resolution, coverage, known biases)
- Variable descriptions (units, valid ranges, how to interpret values)
- Scientific background (relevant atmospheric physics, hydrology, etc.)
- Dataset metadata (temporal coverage, spatial resolution, update frequency)

These documents are chunked and embedded (via the embed() method) into a local vector store. When the user asks a question, relevant chunks are retrieved and added to the system prompt. This gives the AI domain expertise without fine-tuning, and the knowledge updates automatically when feature modules change.

### User Preferences

Stored in Zustand and persisted to localStorage:

- `preferredProvider`: "auto" (default), "cloud-only", "local-only", "offline"
- `cloudModel`: "opus" | "sonnet" | "haiku" (default: "sonnet")
- `localModelName`: string (default: auto-detect from Ollama)
- `maxCloudCostPerSession`: optional spending cap
- `apiKeys`: { anthropic?, openai?, nvidia? } (encrypted in localStorage)

Accessible via the command bar ("use local model", "switch to opus", "go offline") or a minimal settings panel.

## Technical Notes

- Chat state managed in Zustand (messages array, panel state, audio levels, provider config)
- Speech recognition via Web Speech API (Chrome) with fallback to Whisper API
- TTS via Web Speech API or ElevenLabs for higher quality
- Audio engine: Tone.js for procedural/generative audio, Howler.js for sound effects
- LaTeX rendering: KaTeX (lighter than MathJax, fast enough for real-time chat)
- Markdown: react-markdown with remark-math plugin
- AI provider abstraction: src/ai/providers/ with one module per backend
- Intent router: src/ai/router.ts (tier chain with fallback logic)
- RAG store: src/ai/knowledge/ with per-feature document registration
- Vector search: client-side via Vectra or similar lightweight vector DB
