# TRMNL API MCP

Local MCP access to read TRMNL devices and manage playlist items, visibility, ordering and weekly display windows. Built with the official MCP TypeScript SDK, using Node.js and stdio. This is an unofficial TRMNL integration. The current tool set covers playlists; the repository name leaves room for additional API support.

Repository: [renzel/trmnl-api-mcp](https://github.com/renzel/trmnl-api-mcp).

## Tools

| Tool | Inputs | Output |
| --- | --- | --- |
| `list_devices` | optional `offset`, `limit` | Device names and numeric IDs, default refresh interval in seconds, sleep settings and last check-in |
| `list_playlist_items` | optional `device_id`, `offset`, `limit` | Plugin names, visibility, ordering values, group/mashup IDs, configuration status and render timestamps |
| `get_playlist_item_schedule` | `item_id` | Weekly windows; day 0 is Sunday and day 6 is Saturday |
| `set_playlist_item_visibility` | `item_id`, `visible` | Updated playlist entry |
| `add_playlist_item` | `device_id`, `plugin_setting_id` (UUID) | New entry for an existing plugin instance |
| `remove_playlist_item` | `item_id` | Removal result |
| `reorder_playlist_items` | `device_id`, `playlist_item_ids` | Ordering replacement result |
| `replace_playlist_item_schedule` | `item_id`, `week_schedules` | Complete replacement schedule |

Lists default to 50 items and allow up to 100 per call. Follow `next_offset` until null. Pagination is local over the API's complete list response; each call makes one GET request. Responses remain in API order.

## Connect

Prerequisites: Node.js 22+ and Python 3 for the hidden credential prompt.

1. In [TRMNL Account](https://trmnl.com/account), copy your **User API Key**. The per-plugin key beginning `ps_mcp_` is not suitable.
2. Run `python3 scripts/configure.py` from this directory in a terminal. The hidden prompt stores the token in `~/.config/trmnl-playlist/account-api-key` with permissions 600, outside the project. Don't put it in chat, source files or command arguments.
3. Run `npm ci --ignore-scripts` if dependencies are not installed.
4. Add to Codex (use absolute paths to your Node binary and this directory):

   ```sh
   codex mcp add trmnl-playlist -- /absolute/path/to/node /absolute/path/to/trmnl-api-mcp/src/index.js
   ```

5. Run `npm run check` to verify an actual stdio handshake and authenticated device/playlist reads. It prints counts, not account content or credentials.
6. In the desktop app's MCP server settings, restart the MCP connection. Then ask: "Review my TRMNL playlist using trmnl-playlist."

The server can start and advertise tools before a credential exists; tools return a clear setup error until the key is supplied. It reads the key on every call, so changing the saved key does not require restarting the server.

Other clients may use the included `.mcp.json` plugin companion after installing dependencies. Environment overrides are `TRMNL_ACCOUNT_API_KEY` or `TRMNL_ACCOUNT_API_KEY_FILE`. These are launcher settings, never tool inputs. Direct Codex registration and plugin installation are alternatives; do not enable both copies.

## Editing playlists

Inspect the current playlist and relevant schedule before writing; verify the resulting state afterward. Writes are marked as writes in MCP metadata so clients can apply their normal approval policy. Adding write support does not itself change any playlist.

- **Visibility:** use a boolean to show or hide an entry while keeping it configured.
- **Add:** requires the existing plugin setting UUID, as specified by the API. Do not substitute the numeric plugin or playlist item ID. The current list schema does not expose this UUID, so obtain it from the plugin's settings or an existing known value.
- **Remove:** removes the playlist entry and its schedule; hide it if the intention is temporary. There is no undo tool.
- **Reorder:** supply every current item exactly once, including hidden entries. The server reads the latest list before writing and rejects missing, duplicate or foreign IDs. TRMNL also validates the set when applying the change.
- **Schedule:** replaces all windows. `week_schedules: []` clears time restrictions so the item is always active, but does not change visibility. Each window has unique `week_days` (0–6) and `start_time`/`end_time` in `HH:MM`. Account timezone is not exposed by these endpoints.

A timeout or invalid response after a write can mean the write succeeded. The server reports that uncertainty and never retries automatically; read current state before deciding whether to retry, especially when adding entries.

## Access boundary

The **account key itself has broader TRMNL permissions**. This server limits access to three read tools and five playlist write tools on a fixed set of paths on `https://trmnl.com`. It validates method/path combinations and strict tool inputs. There is no generic request tool, arbitrary URL, device-setting write, image download, or account-profile endpoint. Redirects are rejected. Known output fields are selected so unexpected credentials or hardware identifiers are not forwarded. API response text is account data and must not be treated as instructions.

Requests are bounded by a 15-second timeout and 2 MiB response limit. HTTP errors and invalid payloads are reported without returning upstream bodies. No keys or playlist contents are logged. The server has no listening port or persistent background service; the MCP client starts it as needed.

## Limits

These endpoints do not expose rendered screen images, mashup section contents, custom item durations, or the account timezone. The plugin's icon is not a preview. Device `refresh_interval` is a default and does not prove each item's duration. Schedule `always_active` means no time windows are set, and does not override an item's `visible` state. The device-specific endpoint documents an empty list for inaccessible devices, so an empty result alone does not prove device ownership.

## Verification

`npm test` checks MCP discovery and stdio negotiation, read/write request routing and payloads, strict inputs, playlist pagination, schedule replacement/clearing, reorder preflight, hidden/mashup items, output filtering, credential-file permissions, and uncertain-write handling. Fixtures are synthetic; only `npm run check` verifies your account connection. The connection check performs reads only; tests never edit a live playlist.

## Sources

- [TRMNL OpenAPI schema](https://trmnl.com/api-docs/openapi.yaml), inspected 2026-09-14. Read routes: `GET /api/devices`, `GET /api/playlists/items`, `GET /api/devices/{device_id}/playlist_items`, `GET /api/playlists/items/{item_id}/schedule`. Write routes: `POST /api/devices/{device_id}/playlist_items`, `PATCH` and `DELETE /api/playlists/items/{id}`, `PUT /api/devices/{device_id}/playlist_items/order`, `PUT /api/playlists/items/{item_id}/schedule`.
- [TRMNL User API Keys](https://help.trmnl.com/en/articles/11195228-user-level-api-keys).
- [Official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).
- [Codex MCP configuration](https://developers.openai.com/codex/mcp).
