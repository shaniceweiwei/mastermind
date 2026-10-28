# Mastermind Duel

A flat, minimal 2-player online Mastermind game. It's pure static HTML/CSS/JS. The two browsers connect directly over WebRTC through [PeerJS](https://peerjs.com), so there's no backend to run.

## Play

1. One player clicks **Create game** and sends the link to the other player.
2. Before each game, pick a **mode** and the **number of colors** (6–10), then both press **Ready**. Either player can change the settings, and any change un-readies both players.
3. Feedback: ● dark = right color, right spot · ○ light = right color, wrong spot.

**⚔️ Versus:** each player locks in a secret 4-color code, then you take turns guessing each other's code, with up to 10 guesses each. The fewest guesses wins, and the second player always gets an equal number of turns. The winner gets a Jub ticket 💋 and the loser gets a Got ticket 🫂. The loser keeps guessing until they crack the code or run out of guesses, and only then can the next game start.

**🤝 Co-op:** the game picks a random code, and you take turns cracking it together on one shared board, with 10 guesses for the team. If you crack it, you each get a Jub ticket 💋. If you run out, you each get a Got ticket 🫂.

Keyboard: `1`–`9` and `0` pick colors, `Backspace` removes the last one, and `Enter` submits.

## Host on GitHub Pages

```bash
git init && git add . && git commit -m "Mastermind Duel"
git branch -M main
git remote add origin https://github.com/<you>/mastermind.git
git push -u origin main
```

Then in the repo go to **Settings → Pages → Source: Deploy from a branch → `main` / root**. Your game will be at `https://<you>.github.io/mastermind/`.

## Notes

- Each player's secret stays in their own browser. Guesses are scored locally and only the feedback is sent, so nobody can peek at the other player's code with devtools.
- PeerJS's free public server is used only for the initial handshake. On some strict corporate or mobile networks a direct WebRTC connection can fail. If that happens, try a different network.

## Releasing a new version

Bump the version in **two places** so browsers fetch the new files and players can tell versions apart:

1. `VERSION` at the top of `app.js`
2. The `?v=` suffix on `style.css` and `app.js` in `index.html`

The version shows at the bottom of the page. If the two players' versions don't match, the game shows a warning.
