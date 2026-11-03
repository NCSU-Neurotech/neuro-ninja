# Neuro Ninja

Games you play with your eyes and your brainwaves, for NeuroPawn's 8-channel Knight Board: Fruit Slice (Fruit Ninja-style), Fruit Zen, Whack-a-Mole, Simon and Maze. In every game four tiles flicker in the corners of the screen, each at its own rate. Look straight at one and your visual cortex starts pulsing at that rate (an SSVEP); the decoder picks it up, and the game treats it as a pick.

It's a separate app from EXG Visualizer+, with its own launcher, but uses the same board connection, simulator and decoder, copied unchanged into `js/lib`.

> Not affiliated with NeuroPawn or Halfbrick. Not a medical device. The flicker can trigger seizures in people with photosensitive epilepsy: a warning appears every time you press Play.

## Start it

1. Close EXG Visualizer+ and anything else using the board. Only one program can hold the port.
2. Double-click **`Start Neuro Ninja.cmd`**. It opens the game in your browser at http://localhost:8770. Keep its black window open while you play.
3. **Connect:** choose Knight Board and its COM port (or Simulator), set the gain (4 for dry electrodes) and press Connect. The board needs about 2 s per command, so setting up 4 channels with RLD takes about 16 s.
4. **Electrodes:** tick the channels on the back of the head. With NeuroPawn's 10-20 spread that's channels 5–8 (P3, P4, O1, O2); with the SSVEP layout it's all 8. Each shows its signal quality, and channels that are railed, flat or silent are left out.
5. **Play:** pick a game and press Play.

## The games

| Game | How it works | Ends |
|---|---|---|
| 🍉 **Fruit Slice** | Fruit lands on a tile: look at it to slice it. Don't look at bombs. Fruit stays 7 s at first, down to 3.8 s, and more appear at once as you score. 1 point a fruit, 2 if quick, +5 for every 5 in a row. | A dropped fruit or a sliced bomb costs a life; 3 lives |
| 🍊 **Fruit Zen** | The same, with no bombs and no lives. | 90 s |
| 🔨 **Whack-a-Mole** | Moles pop out of the holes: look at one to whack it before it ducks. Golden moles score 3, quick whacks +1, 5 in a row +3. Bunnies pop up too: whacking one costs 5 seconds. Moles stay up 4.5 s at first and 2.6 s by the end, and two can be up at once after 12 s. | 60 s |
| 🎵 **Simon** | The tiles light up one after another, with the flicker off so you can just watch. Then they flicker and you repeat the sequence by looking at each in turn. One step longer each round. Each pick is a trial with a known answer, so the results show your real **pick accuracy**. | 3 mistakes |
| 🧀 **Maze** | The tiles are arrows: top-left up, top-right right, bottom-right down, bottom-left left. Look at one and the mouse runs that way, round bends, until the next fork, so a long corridor costs one look. Arrows into a wall are faded and can't be picked. Each cheese scores 10 + 2 per level, and the next maze is bigger (5×4 up to 12×8). | 3 min |

In every game:

- **Feedback:** a blue ring around a tile fills as the decoder becomes sure, and bars under the tiles show how long a fruit or mole has left.
- **Fair hazards:** a bomb or bunny never appears where the decoder is leaning or where you just picked, and can't count in its first second, so there's always time to look away.
- **Keys:** Esc or Space pauses (leaving fullscreen pauses too), M mutes.
- **Simulator:** point the mouse at a tile instead of looking at it.
- **Results:** every game ends with its own statistics, and the menu shows your best score for each.

## Test your signal: calibration and the accuracy test

The fourth card on the home screen. Both run full screen like a game, behind the same epilepsy warning, and both use the rate set and decision window chosen in Play.

**Calibrate** (about 1 minute):
1. **Rest, 20 s.** Look at a dot in the middle while all four tiles flicker. This records what each tile scores when you *aren't* choosing it. That differs between tiles: a 10 Hz tile scores high at rest because of your own alpha rhythm.
2. **Eight looks.** Look at each tile twice when it gets a red outline. This measures how far above its resting level each tile rises when you do look at it.

From then on, the games and the accuracy test judge each tile against your own resting level (a z-score). A tile is picked only when it stands clear of rest, by its own threshold (z 2 to 5, from its own response), and clear of the runner-up. This is per-person null normalisation, the fix listed as the next step for the decoder's lean towards some targets in EXG Visualizer+.

- Each combination of rate set and window keeps its own calibration. It applies only while the same channels are usable and the mains setting is the same, and the card says when you need to calibrate again.
- Calibration isn't saved if fewer than half of the eight looks were picked right: check the electrodes and try again.
- If a tile responded weakly (z below 3), the results say which one and why. A tile in the 8–13 Hz alpha range gets the advice to use the 12–15 Hz set.
- **Use calibration in games and tests** switches it on and off.

**Accuracy test** (12 or 20 looks, about 1 or 1½ minutes): a red outline shows where to look, then the next 2 s of EEG is scored and the highest-scoring tile is the answer (forced choice, like EXG Visualizer+'s cued test). Each tile comes up equally often, in random order. The results show:
- accuracy against the 25% you'd get by guessing, and the odds of doing that well by guessing;
- information rate in bits per minute;
- each tile's hits;
- when calibrated, the accuracy without calibration on the same trials.

The last result stays on the home card.

**Measured on the simulator**, decoder running with every tile pickable:

| | No calibration | Calibrated |
|---|---|---|
| Phantom picks while looking at nothing for 20 s, 7.5–12 Hz | 5, all on the 10 Hz tile | 0 |
| Phantom picks while looking at nothing for 20 s, 12–15 Hz | 5, spread over tiles | 0 |
| Time to pick a tile you look at, from a cold start, 12–15 Hz | 2.8–2.9 s | 2.8–3.4 s |
| Same, 7.5–12 Hz | 2.8–2.9 s | 2.8–2.9 s, but 6.5 s for the 10 Hz tile |

- **The 10 Hz tile:** calibration flagged it as weak (z 1.2–1.8 against 7–15 for the others), because its response barely rises above alpha. Without calibration it is quick to pick, but it also fires by itself whenever you relax.
- **A Fruit Slice round with calibration:** typical slice time was 1.9 s, against 1.2 s in a round without, so calibration trades a little speed for no phantom picks.
- **The full flow:** one calibration on 12–15 Hz picked 8 of 8 looks right, and the accuracy test after it scored 12 of 12.

## The two rate sets

| Set | Rates | Use it when |
|---|---|---|
| **12 · 13 · 14 · 15 Hz** (default) | clear of the alpha rhythm | Normal play |
| **7.5 · 8.57 · 10 · 12 Hz** | the set that scored 92% and 100% in EXG Visualizer+ cued tests | You want the exact set you tested |

Why the default isn't the 92% set: the brain's own alpha rhythm sits around 10 Hz, and it is strongest when you aren't attending to anything, which in a game is all the time between fruit. A cued test always has a target, so this never showed up there. In the game it did: on the simulator, almost every pick on an empty tile with the 7.5–12 Hz set landed on the 10 Hz tile while the player wasn't looking at any tile (see the measurements below).

## How it decodes

The same method as EXG Visualizer+'s Free mode:

- Every 250 ms the newest window (2 s by default; 1.5 or 3 s in the menu) of the ticked channels is filtered into 5 sub-bands and scored against sine and cosine references at each tile's rate and its harmonics: **filter-bank CCA** (Chen et al., 2015, J Neural Eng 12:046008), with every target given the same number of harmonics in each band.
- A tile is picked once it has led the others by 12% of its score for 0.75 s.
- **A tile just picked can't be picked again until a fresh window has filled** (2.14 s with 2 s windows). Right after a pick the window still holds the old gaze, which in Simon or Maze would otherwise repeat the last pick by itself. Picking the same tile twice in a row (a repeated Simon step, going straight on in the maze) just takes a little longer.
- **Only tiles that mean something right now can be picked**: a tile with a fruit or a mole on it, any tile during Simon's turn, an arrow that doesn't point into a wall. All four are still scored, so a tile has to beat every flickering tile, but looking at an empty tile does nothing. Before this, a few picks per round in Fruit Slice landed on the tile just sliced, and each one locked out picks for a second. With it, 0.6 s passes between picks instead of EXG Visualizer+'s 1 s.
- Works without calibration. With one, the decision uses each tile's z-score against your resting level in place of the 12% lead (see Test your signal).

## Measured on the simulator

The simulator's "brain" answers at the tile under a scripted player's gaze, which looks at each fruit as it lands and at nothing in between. Rounds were 35 s each:

| | 7.5–12 Hz | 12–15 Hz |
|---|---|---|
| Picks on empty tiles (2 rounds, before empty tiles were made unpickable) | 8, all on the 10 Hz tile | 4, spread over tiles |
| Picks on empty tiles (4 rounds, after) | 0 | 0 |
| Fruit dropped | 0 | 0 |
| Typical time from a fruit landing to its slice | 1.1–1.7 s | 0.6–1.5 s |

Every game, 36 s each on 12–15 Hz with a scripted player (looks at fruit and moles but never bunnies, follows the Simon sequence, takes the shortest maze path):

| Game | Result | Speed |
|---|---|---|
| Fruit Slice | 10 sliced, 0 dropped, every pick on a fruit | 1.2 s from landing to slice |
| Whack-a-Mole | 10 whacked, 0 missed, 6 bunnies spared, 0 bonked | 1.9 s per whack |
| Simon | 3 rounds, 9 correct picks, 0 wrong | 2.9 s per pick (the first pick of each turn waits for a fresh 2 s window) |
| Maze | 4 mazes solved in 12 moves | 2.0 s to choose a move |

Drawing one frame at 1280×720 took 0.2–0.5 ms in every game (1.8 ms at worst), against the 16.7 ms a 60 Hz screen allows. Tile and fruit brightness were checked against the target: at flicker levels 0.5 and 0.2, the tile's light measured 0.50 and 0.20, and an orange pixel of the fruit 0.51 and 0.21.

None of this has been tried on a real Knight Board yet. Real alpha is usually stronger than the simulator's, so expect the 7.5–12 Hz set to misfire more on a real head, not less.

## The flicker

- Each tile's brightness follows a sine wave computed from every frame's own timestamp and corrected for the screen's gamma, so any rate works on any monitor and a dropped frame doesn't shift the timing (as in EXG Visualizer+).
- **Whatever is on a tile flickers with it** (fruit, moles, the Simon disc, maze arrows). You look at the thing on the tile, and the centre of your gaze is where most of the response comes from. A still picture on a flickering tile would block the strongest part, so its colours are dimmed and brightened in step with the tile.
- Nothing else flashes. Explosions grow and fade without strobing, and the aim ring and time bar sit outside the tiles.
- Background work (decoding) runs straight after a frame is drawn so it can't delay the next one, and the screen's refresh rate and any late frames are shown at the bottom.

## Files

```
Start Neuro Ninja.cmd   double-click launcher (runs serve.ps1 -Open on port 8770)
serve.ps1              local server: files, COM port list, serial relay (from EXG Visualizer+)
index.html             menu, game stage, epilepsy warning
css/game.css           dark-wood look
js/lib/                copied unchanged from EXG Visualizer+: core, dsp, knight, ports, simulator, linalg, methods
js/eeg.js              connection, signal quality, decoding
js/game.js             engine shared by every game: tiles, flicker, decoding hookup, HUD, effects, pause
js/modes/fruit.js      Fruit Slice and Fruit Zen
js/modes/moles.js      Whack-a-Mole (the moles are drawn in code)
js/modes/simon.js      Simon
js/modes/maze.js       Maze (mazes generated by depth-first carving, cheese on the farthest cell)
js/calib.js            calibration and the accuracy test (hidden modes on the same engine), saved calibrations
js/sfx.js              synthesised sound effects
js/main.js             menu, settings, fullscreen, pause and results
```

A new game is one more file in `js/modes/`: it registers itself in `NP.modes` and supplies its rules and drawing (the list of hooks is at the top of `js/game.js`). The menu picks it up by itself.

If a fix lands in EXG Visualizer+'s copies of the `js/lib` files, copy them over again.
