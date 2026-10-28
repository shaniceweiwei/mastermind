# Mastermind Duel

A flat, minimal 2-player online Mastermind game. It's pure static HTML/CSS/JS. The two browsers connect directly over WebRTC through [PeerJS](https://peerjs.com), so there's no backend to run.

## Play

1. One player clicks **Create game** and sends the link to the other player.
2. Each player locks in a secret 4-color code (repeats allowed).
3. Take turns guessing each other's code, with up to 10 guesses each.
   - ● dark = right color, right spot
   - ○ light = right color, wrong spot
4. The fewest guesses wins. The second player always gets an equal number of turns, so a tie is possible.

Keyboard: `1`–`6` pick colors, `Backspace` removes the last one, and `Enter` submits.

## Host on GitHub Pages

```bash
git init && git add . && git commit -m "Mastermind Duel"
git branch -M main
git remote add origin https://github.com/<you>/mastermind.git
git push -u origin main
```

Then in the repo go to **Settings → Pages → Source: Deploy from a branch → `main` / root**. Your game will be at `https://<you>.github.io/mastermind/`.

## Rejoining

If either player refreshes, loses connection or closes the tab, open the same link or enter the same room code to come back. The game is saved in your browser, so you continue where you left off, with the same round, guesses and tickets. If one player comes back on a different device, there's no saved game there, so a fresh round starts (the tickets are kept).

## Notes

- Each player's secret stays in their own browser. Guesses are scored locally and only the feedback is sent, so nobody can peek at the other player's code with devtools.
- PeerJS's free public server is used only for the initial handshake. On some strict corporate or mobile networks a direct WebRTC connection can fail. If that happens, try a different network.
