# Videos

DGC makes short video clips with **your own video generators**: a video model on fal.ai, Gemini or Replicate (with the
key you already use for pictures), or a ComfyUI video workflow on a computer of yours. Ask in plain words, in Work, in
ChatDGC or in a Pip's chat, and the model makes it with `generate_video`. Nothing is set up by default.

A clip costs real money (about $0.10 to $2, against a fraction of a cent for a picture) and takes from half a minute
to several minutes. By default, DGC shows a card with the price before sending it; you can turn asking off for an
individual generator in Settings. DGC makes one at a time unless you ask for more.

## Generators

A video model is a generator of its own, beside your picture generators in Settings → Models → **Images & video**. A
generator is one model on one provider, so a fal video model is its own generator and uses the same saved fal key as
your fal picture generator. Each one says what it makes (pictures, videos or both) and, for video, its price per
second.

| Provider | How DGC talks to it | Default model |
|---|---|---|
| fal.ai | its queue: submit, then status, then the result; Stop cancels it there | Wan 2.2 5B (the cheapest good one) |
| Google Gemini | Gemini Omni Flash through the Interactions API, in the background; a Veo model as a long-running operation | Gemini Omni Flash |
| Replicate | a prediction: create, then read it; Stop cancels it there | Wan 2.2 fast |
| ComfyUI | your video workflow (Wan, LTX-Video) in API format, mapped like a picture workflow; on DGC Router too | your workflow |

Runway and Higgsfield make videos through their plugins (Settings → Plugins), not here.

Gemini video has no free tier: a key whose project has no billing gets "needs credit", said plainly ("Gemini video
needs a paid Gemini API project"). Google shut Veo down in the Gemini API on 2026-10-22 (its deprecations page); DGC
still speaks Veo's operation API for a model that answers it, and uses Gemini Omni Flash by default.

### Adding one

```
dgc videos add fal                          # fal Wan 2.2 5B, on the key your fal pictures use
dgc videos add fal --model fal-ai/kling-video/v2.5-turbo/pro/text-to-video
dgc videos add gemini                       # Gemini Omni Flash
dgc videos add comfyui gpu-box.local:8188 --workflow wan22-api.json
```

Or in Settings → Models → Images & video → + Add generator → It makes: Videos. For ComfyUI, export your workflow with
Workflow → Export (API); DGC finds its prompt, negative prompt, seed, size, length (frames), frames per second and
start image, and shows you that first.

## Prices

DGC's estimate, from each provider's own page, read on **2026-11-02**. Prices change often; the provider's bill is what
counts. DGC shows "about".

| Model | Price | Page |
|---|---|---|
| fal Wan 2.2 5B (default) | $0.15 a clip, up to about 5 s at 720p | [fal.ai](https://fal.ai/models/fal-ai/wan/v2.2-5b/text-to-video) |
| fal LTX-Video 13B distilled | $0.02 a second | [fal.ai](https://fal.ai/models/fal-ai/ltxv-13b-098-distilled) |
| fal Hailuo 02 Standard | $0.045 a second (768p) | [fal.ai](https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/text-to-video) |
| fal Kling 2.5 Turbo Pro | $0.07 a second | [fal.ai](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/text-to-video) |
| fal Wan 2.5 | $0.05 / $0.10 / $0.15 a second at 480p / 720p / 1080p | [fal.ai](https://fal.ai/models/fal-ai/wan-25-preview/text-to-video) |
| fal Veo 3.1 Fast | $0.15 a second, with sound | [fal.ai](https://fal.ai/models/fal-ai/veo3/fast) |
| Gemini Omni Flash | about $0.10 a second at 720p (token-priced) | [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Gemini Veo 3.1 Fast / Veo 3.1 | $0.15 / $0.40 a second (shut down in the Gemini API) | [Gemini API deprecations](https://ai.google.dev/gemini-api/docs/deprecations) |
| Replicate Wan 2.2 fast | about $0.05 a clip at 480p, $0.10 at 720p | [Replicate](https://replicate.com/wan-video/wan-2.2-t2v-fast) |
| ComfyUI | free, on your computer | |

## The card

When asking is on, the video card shows the generator, the length and resolution, the price ("5 s · 720p · about $0.15"),
this month's spend against the generator's limit, and the prompt. Its buttons are **Make it · about $0.15**, **Edit**
(change the prompt and it asks again) and **Don't**. There is no Always allow on the card: in Settings each video
generator has **Asks before each video**, on by default; turning it off there is the only way to make videos without
asking. A model in auto mode, a permission rule or a monitor's wake never answers a video's card.

DGC never falls back by itself to another paid generator. A provider's own failure ("needs credit", "bad key", a
content refusal) is said in plain words, to you and to the model, which is told to stop and tell you what to fix.

### The monthly limit

A generator's monthly limit (`dgc images edit ID --limit 5`) is read against everything made **on its key** this
month: pictures and videos alike, the videos still running and the pictures being made, in every DGC window. A clip
that would pass it says so on its card and is never sent. The limit is checked again just before a clip is sent, and
the job is written down at that moment, so two windows (or two cards made before either was sent) can't both use the
same room under it.

- What the provider may have charged stays counted: a clip stopped once it had started, one the provider finished,
  one DGC couldn't download or save. It comes off only when the provider says nothing was charged (it stopped the
  clip before it started, or said the job itself failed).
- A price DGC doesn't know (a model it has no price for) can't be held to a limit: under one, the clip always shows
  its card, saying so, even with **Asks before each video** off, and a Pip's routine never makes it.

## A long job

- **Work:** the call starts the job and comes back at once ("Started a 5 s video with fal Wan 2.2 5B (720p, about
  $0.15), about 1–2 min"). The chat carries on. The step shows the provider's state, the time so far and Stop; when
  the video is ready the model is told (the chat wakes, as for a background sub-task's result) and the player appears
  under the reply that asked for it.
- **ChatDGC:** the card under the reply turns into the job's progress and then its player. It is kept with the chat.
- **Pips:** in a Pip's chat, the Pip asks in its reply with the price; only your yes in your next message makes it.
  A routine never makes a video unless you allowed that Pip for that generator (`video_pips` in the generator's
  settings, listed in Settings). The reply shows the video when it's ready.
- **Stop** cancels the job, at the provider too where it can (fal, Replicate, ComfyUI), and says what was charged:
  nothing when it hadn't started, "may still charge" once it had, and plainly when the provider can't stop it.
- **A reload** never loses a job: it is kept on disk (`~/.dgc/videos/jobs/`) from the moment it starts, the next DGC
  polls it again, and a reopened chat is told of a video that finished while it was closed.

## Where videos go

- By default into DGC's own folder: `~/.dgc/videos/sessions/<session>/` for Work, `chats/<chat>/` for ChatDGC,
  `pips/<pip>/` for a Pip. Beside each one, a sidecar `<name>.json` (prompt, provider, model, seed, length, size,
  cost) and, when ffmpeg is on the computer, a poster frame `<name>.jpg`.
- Into the project only with `save_to` (a path in the project, which the model gives when you name a place) or the
  player's **Save to project…**, with the same checks as writing a file.
- **Size:** at most 300 MB a file. A 5–10 s clip from these providers is 2–30 MB; 300 MB leaves room for a long 4K
  clip and still stops a runaway download from filling a disk.

## The player

In Work, ChatDGC and a Pip's chat the video is drawn where a picture is: a `<video>` with its poster frame, its length
and size, and **Open** (your system player), **Show in folder** and **Save to project…**. The Library has a
**Videos** tab: every video DGC made, newest first, by where it was made.

## Terminal and SDK

```
dgc videos                         # the video generators and the jobs running
dgc videos make "a felt ball rolls across a desk" --duration 5      # asks first; --yes for a script
dgc videos jobs · dgc videos show JOB · dgc videos stop JOB · dgc videos open JOB · dgc videos library
```

In the terminal app, `/videos`, `/videos jobs`, `/videos stop JOB`, `/videos open JOB`; a finished video says
"Made a 5 s video with fal Wan 2.2 5B · 720p · $0.15", its path, and `/videos open JOB`.

The SDK has `session.videos` (Python and TypeScript): `generators()`, `generate(prompt, approve=True)` (it follows the
job until it ends unless `wait=False`), `jobs()`, `stop(job)`, `wait(job)` and `library()`. On the wire:
`videos_jobs`, `videos_stop`, `videos_generate` and `videos_library`, answered by `video_jobs` and `videos_library`,
with `video_job` events once a client has asked (`ready.capabilities.videos`).
