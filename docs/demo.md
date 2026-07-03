# Demo GIF

The README uses `docs/assets/quest-demo.gif`.

To replace it with a real terminal capture:

```bash
# Option A: VHS
brew install charmbracelet/tap/vhs
vhs docs/quest-demo.tape

# Option B: asciinema + agg
brew install asciinema agg
asciinema rec docs/quest-demo.cast
agg docs/quest-demo.cast docs/assets/quest-demo.gif
```

Keep the capture short: create a quest, show kanban, finish with the quest recap.
