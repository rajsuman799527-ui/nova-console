# NOVA Console

Phones as game controllers. TV screen + up to 5 phones, live over Supabase Realtime. No server needed.

## Setup
1. Supabase: new project, then Project Settings > API. Copy the URL and anon key into `shared/config.js`. Realtime Broadcast and Presence work out of the box, no tables needed.
2. GitHub: push this folder to your repo.
3. Cloudflare Pages: connect the repo. Build command empty, output directory `/`.
4. Open `/screen/` on the TV, scan the QR with a phone.

## How it works
- TV creates a 6-digit room and shows code + QR.
- First phone = Player 1, becomes the menu remote (D-pad, OK, Back).
- Game starts: every phone turns into the PlayStation pad (D-pad, Select/Start, four face buttons, two sticks).
- Max 5 players. A 6th phone sees "Room is full".
- Player 1 presses Select in a game to return to the menu.

## Add a game
Add an entry in `GAMES` (`shared/config.js`), then handle `mode === 'game'` and `game === '<id>'` in `screen/index.html`. Inputs arrive as `{t:'btn',k,d}` and `{t:'stick',s,x,y}` per player slot.
