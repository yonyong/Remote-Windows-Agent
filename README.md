[中文文档](README.zh-CN.md)

# Sirius (Remote Windows Agent)

**Sirius** is a compact, end-to-end demo of **remote Windows automation** built around a **conversational web client** and a **Fastify + SQLite control plane** that pairs users with machines and keeps chat history in one place. **Natural language** becomes validated **CommandSpec** JSON through **rule**, **hybrid**, or **LLM-backed** parsing, and a **Node.js WebSocket agent** on Windows runs those commands locally while streaming logs and screenshots back to the UI. The subtitle **Remote Windows Agent** names that on-machine executor—the process that actually drives the desktop, not the cloud model by itself.

---

## Overview

- A **WeChat-style** web client (messages, contacts, device details, optional custom “agent friends” and casual chat).
- A **control plane** (Fastify + SQLite) for **auth**, **device pairing**, **command dispatch**, **chat history**, and **LLM-assisted parsing** of natural-language commands.
- A **Windows agent** (Node.js + WebSocket) that receives commands from the control plane and runs desktop automation (logs and screenshots are reported back).

> **Scope:** MVP / demo quality. Do **not** expose to the public internet without hardening (TLS, rate limits, strong secrets, operational monitoring).

## The role of AI

AI is not a decorative add-on here: it is the bridge between **how humans describe intent** and **what the Windows agent can safely execute**.

- **Natural language → structured commands.** You type goals in plain language (e.g. “open Notepad and type hello”). The control plane turns that into a typed **command spec** (JSON) that the agent understands, using either **rules**, **rules + LLM (hybrid)**, or **LLM-first** parsing—configurable per user under **Me → Parse settings**.
- **Provider flexibility.** The same flow supports Zhipu GLM, OpenAI-compatible APIs (including common proxies), and Gemini, with per-user keys stored in SQLite and optional **environment-variable defaults** for labs or single-tenant setups.
- **Graceful degradation.** If no API key is set, the model errors, or you choose **rule** mode, the system still works: parsing falls back to deterministic rules so automation remains usable without cloud AI.
- **Chat-shaped UX.** The web client feels like a messenger on purpose: conversation history and “agent friends” sit alongside device control, so **LLM-assisted parsing** and casual chat can share one mental model—commands and chat both flow through the control plane, with clear separation between **automation payloads** and **conversation**.

Treat API keys and parse settings like secrets; they grant the ability to send interpreted commands to paired machines.

## Architecture

```mermaid
flowchart LR
  subgraph client [Browser]
    FE[React frontend]
  end
  subgraph server [Control plane]
    CP[Fastify + SQLite + NL command parse]
  end
  subgraph cloud [LLM providers]
    LLM[Zhipu GLM / OpenAI-compatible / Gemini]
  end
  subgraph pc [Windows host]
    AG[Agent WebSocket client]
  end
  FE <-->|HTTPS JSON| CP
  CP <-->|NL to CommandSpec, HTTPS when LLM or hybrid| LLM
  CP <-->|WebSocket, structured CommandSpec| AG
```

## End-to-end flow (natural language → desktop action)

```mermaid
flowchart TD
  U[User describes intent in natural language] --> FE[Frontend sends message or command request over HTTPS]
  FE --> CP[Control plane: JWT, device scope, chat / audit persistence]
  CP --> P{Command parse path}
  P -->|rule| R[Rule engine builds CommandSpec]
  P -->|hybrid or llm| M[LLM provider: natural language → structured command]
  M --> V{Parse OK?}
  V -->|no or timeout| R
  V -->|yes| CS[Validated CommandSpec JSON]
  R --> CS
  CS --> WS[WebSocket: dispatch CommandSpec to paired Windows agent]
  WS --> AG[Agent executes UI / shell automation locally]
  AG --> BK[Agent reports logs and screenshots to control plane]
  BK --> UI[Frontend refreshes thread, device status, or media previews]
```

**Hybrid** mode may try rules before calling the model; on model failure the control plane falls back to **rule** parsing, same as **llm** mode when no key is configured.

## Repository layout

| Path | Role |
|------|------|
| `control-plane/` | HTTP API, JWT auth, device lifecycle, parse settings, agent catalog, WebSocket bridge to agents |
| `agent/` | Node/TypeScript agent: connects with pairing code or device token, executes commands |
| `frontend/` | Vite + React UI (mobile-style shell) |
| `shared/` | Command spec JSON schema and protocol notes |

## Prerequisites

- **Node.js** 20+ recommended (for `control-plane`, `agent`, `frontend`)
- **Windows** machine (or VM) for the agent, if you want real desktop automation

## Quick start (local dev)

### 1. Control plane

```bash
cd control-plane
npm install
npm run dev
```

Default: `http://127.0.0.1:8787` (or `http://localhost:8787`).

### 2. Agent (Windows)

```bash
cd agent
npm install
npm run dev
```

On first run the terminal prints a **pairing code** and writes `agent/pairing-code.txt` next to `agent/agent-state.json`. Use that code in the web app (**Contacts → Add device**) to bind the machine.

To force a new pairing code: delete `agent/agent-state.json` and restart the agent.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the URL Vite prints (often `http://localhost:5173`). **Register / log in**, and set the **control plane base URL** if your phone or another PC opens the UI (use the LAN IP of the machine running the control plane, **not** `localhost` from another device).

## Command parsing (rule / hybrid / LLM)

After login, use **Me → Parse settings** / **Model settings** to choose **parse mode**, vendor (Zhipu GLM, OpenAI-compatible, Gemini), model, base URL, and API key (stored in SQLite `user_parse_settings`).

APIs: `GET/PUT /me/parse-settings`, `POST /me/parse-settings/test`.

If nothing is saved in the UI, the control plane can fall back to **environment variables** (global defaults):

| Variable | Purpose |
|----------|---------|
| `COMMAND_PARSE_MODE` | `rule` \| `hybrid` \| `llm` |
| `DEFAULT_LLM_PROVIDER` | `zhipu` \| `openai_compatible` \| `gemini` |
| `ZHIPU_API_KEY` / `ZHIPU_MODEL` / `ZHIPU_API_BASE` | Zhipu defaults |
| `OPENAI_API_KEY` or `OPENAI_COMPAT_API_KEY` or `DEEPSEEK_API_KEY` | OpenAI-compatible fallback |
| `OPENAI_BASE_URL` / `OPENAI_COMPAT_BASE_URL` | OpenAI-compatible base URL |
| `GEMINI_API_KEY` | Gemini fallback |
| `COMMAND_TEXT_MAX_CHARS` | Max chars sent to the model (default `900`) |

If no usable key is configured or the model fails, parsing falls back to the **rule engine**.

## Production notes

- Prefer **HTTPS** and a real **JWT secret** (`JWT_SECRET` on the control plane).
- Protect `control-plane.sqlite` (contains user hashes, parse settings, device tokens).
- Plan for **device revocation**, audit logs, and backups before any wide deployment.

## License

This project is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE).

## Quick links

- Control plane default port: **8787**
- Frontend dev default (Vite): **5173**
- Pairing artifact: `agent/pairing-code.txt`
