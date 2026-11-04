# Image generation

DGC makes images with **your own image generators**: ComfyUI or an Automatic1111-style server on a computer of
yours, and the online services you have a key for. Ask for a picture in plain words, in Work, in ChatDGC or of a Pip,
and the model makes it with `generate_image`. Nothing is set up by default.

## Generators

Add as many as you like, side by side. Each one has a provider, an address or a key, a model (or a ComfyUI
workflow), a default size, and a short "good for" that DGC fills in and you can change.

| Provider | What it covers | Costs |
|---|---|---|
| ComfyUI | any model you run in ComfyUI (FLUX.2, Qwen-Image, SDXL, Z-Image…), with your own workflow | free, on your computer |
| Automatic1111-compatible | Automatic1111, Forge, reForge, SD.Next, and Draw Things' HTTP API | free, on your computer |
| OpenAI-compatible | OpenAI's GPT Image models, xAI, Together, LocalAI, and any server with `/v1/images/generations` | per image, or free locally |
| Google Gemini | the Gemini image models (generation and editing) and Imagen | per image |
| Black Forest Labs | FLUX.2, FLUX 1.1 Pro and Kontext editing | per image |
| fal.ai, Replicate | one key, hundreds of models (FLUX, Seedream, Qwen-Image, Ideogram, Recraft, Imagen…) | per image |

Runway and Higgsfield make images and videos through their plugins (Settings → Plugins), not here. Ollama's own
image generation is still experimental and has no settled HTTP endpoint; DGC tries `/v1/images/generations` there and
says plainly when the server has none.

### Adding one

In plain words: *"add my ComfyUI at gpu-box.local:8188"*. Or from a terminal:

```
dgc images add comfyui gpu-box.local:8188 --name "ComfyUI on gpu-box"
dgc images add fal --key            # the key is read from the terminal or a pipe, never the command line
dgc images add gemini --model gemini-2.5-flash-image --key
dgc images add a1111 mac.local:7860
dgc images test
```

In the terminal app: `/images`, `/images add comfyui gpu-box.local:8188`, `/images key fal`, `/images test`.

A ComfyUI generator with no workflow uses DGC's own text-to-image workflow with the checkpoint you name (or the
server's first one), with the few steps a Turbo or Lightning model needs. To use your own, export it from ComfyUI with
**Workflow → Export (API)** and add it with `--workflow file.json`. DGC finds where it takes the prompt, the negative
prompt, the seed, the steps, the size and the input image, and shows you that mapping first:

```
DGC found these inputs in the workflow:
  Prompt → node 6 (CLIPTextEncode, "Positive").text
  Negative prompt → node 7 (CLIPTextEncode, "Negative").text
  Seed → node 3 (KSampler).seed
  Width → node 5 (EmptyLatentImage).width
Use these? [Y/n]
```

## Which one is used

- The one you name ("use ComfyUI for this") is used for that image.
- Otherwise this project's choice. The first time a project needs an image and more than one generator fits, DGC
  asks you which, and remembers the answer in the project's `.dgc/images.json`. `dgc images default ID --project`
  changes it.
- Where nobody can be asked (`dgc -p`, the SDK), the default generator (`dgc images default ID`), else a free one
  first.
- An edit (an image to change) goes only to a generator that can edit; the model sees what each can do: edit, mask,
  text in the image, the largest size, and whether it works right now (key valid, credit left, server up).

## Money

- A paid generator **asks before each image**: its Allow card shows the provider, model, size, how many and the price
  (DGC's estimate from the provider's published price). This holds in every mode, auto included.
- An **OpenAI-compatible server outside your own network** (a hosted service) counts as paid, so it asks too. One on
  this computer or your local network doesn't; moving it to an outside address makes it ask again.
- **Always allow** on that card makes it stop asking. You can set a **monthly limit** for a generator
  (`dgc images edit fal --limit 5`): once this month's spend would pass it, DGC asks again.
  - The limit counts everything on the generator's key this month: pictures and videos made, pictures being made
    right now and videos still running, in every DGC window. It is checked again just before each picture is sent,
    so two windows (or two requests worked out before either ran) can't both use the same room under it.
  - A price DGC doesn't know (a model it has no price for) can't be held to a limit, so under one it always shows
    its card, saying so, even for a generator that doesn't ask.
  - A picture the provider made counts, even if DGC couldn't save it; one the provider refused costs nothing.
- A free or local generator never asks.

When a provider says you're **out of credit** (Gemini's "free tier is not available for this project", fal's "User is
locked. Reason: TOP_UP", OpenAI's `insufficient_quota`), DGC uses a free generator instead by itself, and says so. It
never moves to a paid one on its own: it offers you the others that fit, unless you turned on automatic fallback
(and even then a paid one still shows its card). A rate limit, a bad key or a server that is down is handled the
same way. A refusal by the provider's policy is said as it is.

## Where the images go

- **Work:** into DGC's own folder, one per session (`~/.dgc/images/sessions/<session>/`), as Codex keeps its pictures
  in its home: nothing lands in your project unless you want it there. The picture shows under the reply and in the
  Library either way. Each image has a sidecar `NAME.json` beside it: the prompt, provider, model, seed, size and
  cost.
  - **Into the project when it's wanted:** the model gives `save_to`, a path in the project, when you name a place or
    the task needs the file there ("add a hero image to the landing page"). The same checks as writing a file apply:
    inside the project, never into `.git` or `.dgc`, no replacing a file without asking (`replace: true` only after you
    say so), and in Work the same permission a write of that path gets (default mode asks, on the one card that also
    shows any price).
  - **Save to project…** under each picture (Work, ChatDGC and the Library) copies it into the folder open in VS Code,
    `assets/` unless you pick another place.
  - **Save images in** (Settings → Models → Images & video, or `images.save_dir`) still sends every picture to a folder of the
    project for anyone who sets one. Pictures already saved in a project stay where they are.
  - `dgc images generate` and the SDK's `images_generate` save in DGC's folder too (`--out` / `save_to` for the
    project).
- **ChatDGC:** into the chat's folder (`~/.dgc/images/chats/<chat>/`), under the reply, and in the Library (Images,
  Made by ChatDGC). A paid generator there puts a card under the reply with its price; nothing is made until you send
  it.
- **Pips:** a Personal Pip makes images in its chat and its tasks; they're kept with its reply and in
  `~/.dgc/images/pips/<pip>/`. A Pip never spends on its own say-so: it asks you in its reply, with the price, and
  makes the image only after your yes. A routine's run never makes a paid image.

The image is saved exactly as the provider sent it: watermarks and C2PA or SynthID metadata are kept, never stripped.
Every image DGC made is listed in `~/.dgc/images/library.jsonl` (the editor's `images_library`).

## In the editor

**Settings → Models → Images & video** lists your generators, each with its provider and model, its price, whether it works
right now (works, needs credit, rate limited, bad key, server down, with what the provider said), the **Default**
badge, its key (saved, or from `FAL_KEY` and the like; never the key itself) and this month's spend against its
limit. **Asks before each image** switches on each row, and an **Always allow** on a card turns it off there too.

- **+ Add generator**: choose the provider, then its address (for a server on your computer) or its key. The key goes
  to DGC once, in a step of its own, and is never shown again; DGC then tests the new generator and says how it went.
- **A ComfyUI workflow**: choose the file you exported with **Workflow → Export (API)**. DGC shows, on one screen,
  where it found the prompt, the negative prompt, the seed, the size and the input image (`node 6 (CLIPTextEncode,
  "Positive").text`), and anything missing. Change a target if it's wrong, then **Add with these**. Nothing is saved
  before that.
- **Edit**, **Remove** (asked first), **Make default**, **Test** and **Test all** on each row; changing a generator's
  address drops its saved key, and the form says so.
- **This project uses** (or "Ask me when several fit"), **When one needs credit** (automatic fallback; a paid one
  still asks) and **Save images in** (blank: DGC's own folder; or a folder in the project) sit under the list.
- A generator on a DGC Router system names it, with a link to the Systems list. Runway and Higgsfield work through
  their plugins.

Every change is saved as you make it. An older DGC CLI shows no Images section.

In Work, the pictures a turn made show under its reply (its steps keep their tiles), and a paid generator's
Allow card says what it will make, with which generator, how many, the size, the price and the prompt: **Make it**,
**Edit** (ask again with a changed prompt), **Always allow** or **Don't**.

The **Library**'s Images show the images DGC made in Work beside ChatDGC's, newest first, and **Made in Work** shows
only those: open one, show it in its folder, or save a copy into the project.

In a step's row, a generated image reads *Made 1 image with ComfyUI · 768×320 · free* and where it was saved; the
sentences DGC writes for the model (the sidecar, which other generators it may offer) stay in what the model reads.

## DGC Router

A Router system can carry the **images** job: a ComfyUI or Automatic1111 box, or a computer that also runs your chat
models. Give a generator that system (`dgc images edit comfy --system gpu-box`) and, while the Router is on, each
picture holds one of that system's workers while it is made. On a one-model-at-a-time computer a picture and a big
chat model never run there together.

```
dgc router add gpu-box.local:8188 --name "GPU box images"     # found as ComfyUI: the images job
```

## Commands and the model's tools

- `/images` (list) · `/images add PROVIDER [ADDRESS] [NAME]` · `/images test [ID]` · `/images default ID` ·
  `/images use ID` (this project) · `/images key ID`.
- `dgc images list|add|edit|remove|test|default|generate`, each with `--json` for scripts. `dgc images generate
  "a red fox" --count 2` makes images from the terminal; a paid one asks, or `--yes`.
- The model's tools: `generate_image` (prompt, size or aspect, count 1-4, images to edit, mask, generator, model, seed,
  save_to) and `list_image_generators`. They are offered every turn; the model decides.
- The SDK: `session.images.generate(...)`, `.generators()`, `.add()`, `.set_key()`, `.test()`, `.library()`, and
  `images_made` events in a run.

The settings live in `~/.dgc/config.json` under `images`; each generator's key in `~/.dgc/secrets.json`, bound to its
address (change the address and the key is dropped). A provider's own environment variable (`FAL_KEY`,
`GEMINI_API_KEY`, `OPENAI_API_KEY`, `BFL_API_KEY`, `REPLICATE_API_TOKEN`, `XAI_API_KEY`, `TOGETHER_API_KEY`) is used
for its official address when no key is saved. The model's tools never read or set a key.
