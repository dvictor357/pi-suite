Output docs/assets/quest-demo.gif
Set FontSize 18
Set Width 900
Set Height 520
Set Theme "Catppuccin Mocha"

Type "/quest create \"Add polished quest recap\""
Enter
Sleep 800ms
Type "quest_plan(steps: scan codebase, add recap, update README)"
Enter
Sleep 800ms
Type "/quest kanban"
Enter
Sleep 1200ms
Type "quest_update(index=0, status=done, result=\"Recap helper added.\")"
Enter
Sleep 700ms
Type "quest_update(index=1, status=done, verifyOutcome=PASS)"
Enter
Sleep 700ms
Type "Quest Recap: 3/3 done, 2 verified, 1 commit"
Sleep 1500ms
