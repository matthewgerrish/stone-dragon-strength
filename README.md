# Stone Dragon Strength Training

A coach + athlete training program manager.

- **Coach side:** design phased programs, schedule workouts on a shared calendar, track PRs, sync athlete logs.
- **Athlete side:** view program, check off completed days, log weight × reps, watch demo videos, send progress back to coach.

100% static site (HTML/CSS/JS + PWA). Data stored in `localStorage`; coach/athlete sync via copy-paste invite + progress codes — no backend required.

## Local development

Open `index.html` in a browser, or serve the folder over HTTP:

```bash
python3 -m http.server 5190 --directory .
```

Then visit <http://localhost:5190>.

## Deployed

Lives at <https://sleeperhomes.com>.
