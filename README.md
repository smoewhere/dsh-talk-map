# dsh-talk-map · Talk Map

English | [中文](README.zh.md)

A visual conversation map plugin for DeepSeek Harness (dsh): every session becomes a card on an infinite whiteboard.

> Derived from [Tasihi89/dsh-talk-map](https://github.com/Tasihi89/dsh-talk-map) (MIT). This repository is a heavily reworked fork: slot layout, resizable workspaces, the overflow drawer and the routed links are additions or rewrites here.

![Workspaces, pinned cards and live status](https://raw.githubusercontent.com/Da0Mine/dsh-talk-map/main/docs/screenshots/workspaces-and-pins.png)

![Cards connected by links, with running / waiting / unread lamps](https://raw.githubusercontent.com/Da0Mine/dsh-talk-map/main/docs/screenshots/cards-and-links.png)

- **Built-in recycle bin**: the map and native session list share confirmed deletion, single/batch restore, and permanent deletion. Native session rows use DSH's own context menu from 0.2.2; Talk Map adds Delete conversation to it. Group deletion targets its mapped conversations; ordinary forks remain independent. On rc.5, opened idle sessions are released through their native lifecycle before deletion. Running work requires confirmation and has a 15-second stop timeout. The recycle bin shows storage usage, size sorting, and estimated space released before permanent deletion. Restart once after upgrading to enable native handle tracking.
- **Spatial memory instead of working memory**: free placement + grid snapping, and nothing ever rearranges your cards — if you remember "that conversation was bottom-left", it stays bottom-left. Designed for ADHD users, useful for everyone.
- **Folders stay readable**: frames grow without covering neighbors, up to six slots by default. Overflow occupies the last slot: seven conversations show five cards and a “+2” stack that opens a drawer. Pinned cards stay in front. Resizing switches a frame to manual sizing; its context menu restores automatic sizing. The sizing preference is saved in the current browser.
- **Archives stay identifiable**: archived cards keep their positions and links, carry an Archived badge, and contribute to archive counts on frames and stacks. Their context menu offers Unarchive and Delete; restore a conversation before opening it.
- **Double-click to chat**: double-click empty canvas to start a new session; the card is born exactly where you clicked.
- **Draw an edge to fork**: drag a line from a card onto empty space, preview (and edit) the context digest to inject, confirm — a new session starts *knowing* the old conversation.
- **Card front = resume surface**: title, the last thing you said, relative time and a status lamp (running / finished / unread / waiting / interrupted). One glance tells you what to do next.
- **Lines mean something**: a link whose context is still up to date disappears; one that has fallen behind stays visible as a dashed line with an arrow. Fork lineage is always drawn.
- **Automatic digests**: a three-field digest (summary / key findings / next step) is generated on demand through your deployment's default model; hit ⟳ on a card to regenerate.
- **Bilingual interface**: the map's own copy renders in Chinese or English. The pill in the map header cycles Auto → 中文 → English; Auto follows dsh's own language, and the choice is remembered across restarts.

- **Status rail**: a collapsible strip on the left edge lists only cards with a lamp (running / waiting / unread / interrupted). Click or press Enter / Space to open the conversation, or drag to reorder. Changed statuses rise to the top; cleared statuses leave the list. The rail remembers its open state, and the map controls move aside when it opens.

## Install

```sh
# npm (recommended)
dsh plugin add dsh-talk-map

# or straight from GitHub — built artifacts are committed, so there is no build step
dsh plugin add github:Da0Mine/dsh-talk-map
```

Restart `dsh web`; a map button appears at the sidebar foot.

## Usage

| Action | Effect |
|---|---|
| Sidebar map button / Esc | toggle the map |
| Drag a card | place it (16px grid snap, persisted) |
| Double-click empty space | create a session there and enter it |
| Double-click a card | open that session |
| Drag from a card handle to empty space | preview injection → fork a new session |
| Click a stack cell | open the drawer listing the folded conversations |
| ⟳ on a card | regenerate the digest |
| Right-click a card / a line / a folder | pin, rename, mark unread, archive, delete, push switch, delete line |
| Language pill in the map header | cycle Auto → 中文 → English |

## Where data lives

- Canvas data (positions, edges, digests): `$DSH_HOME/storages/talk_map.json` via dsh's official storage-domain, atomically persisted.
- Validated session/subagent logs and recovery metadata move into `$DSH_HOME/talk-map-trash/entries/`. Restore is reversible; permanent deletion is not. Project files, generated deliverables and attachments are retained. Sizes are logical file sizes, not total DSH installation size or filesystem allocation reclaimed.
- Digests use your configured default model through dsh's local LLM channel; there are no other external requests.

## Compatibility

The session lifecycle adapter targets DeepSeek Harness `0.2.1-rc.5`, tested with its actual AgentLoop, SessionStore and JSONL/Zstd components. Missing native handles refuse only the affected resident session; external writer leases still block deletion. The structural contracts live in `src/client/dsh.ts` and `src/host/dsh-host.ts` — start there when upgrading.

## Roadmap

Multi-board shelf (project = board, WIP limit) · whole-board archive/shelve · timeline view (camera fly-back) · alias cards · multi-parent merge UI · selection-level injection · quick-ask on card.

When upgrading a test package, fully quit DSH (including the tray background process), install, then restart. Ordinary deletion retains the legacy request shape. Stop-and-delete checks backend capabilities first; a mismatch prompts a restart without sending a stop or delete request.

Successful deletion updates the session list and map without a count notification. Restore deleted sessions from the recycle bin; restoration refreshes the native session list and map without reloading the page. Deletion failures still show a notice. Other bottom notices dismiss after 5 seconds, pausing during hover or keyboard focus. Confirmation dialogs do not time out.

## Development

Keep one version number throughout an unreleased feature’s bug-fix cycle. Distinguish local test packages by `testN` in their filenames, then publish once after acceptance.

```sh
pnpm install
pnpm run build        # host → lib/, client → client/client.js
pnpm run probe        # headless end-to-end probe (150 checks)
pnpm run test:trash
pnpm run test:lifecycle
pnpm run test:trash:api # legacy request compatibility and stop capability negotiation
pnpm run test:trash:real # isolated installed rc.5 components, no model calls
pnpm run test:trash:ui   # shipped-client browser checks
# Use the Git installation workflow for release acceptance; do not link this checkout.
```

MIT License.
