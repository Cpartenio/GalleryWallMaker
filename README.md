# Gallery Wall Maker

Snap a photo of your wall, erase what's hanging, then rearrange it on your iPad, and try new pieces, before you put a single nail in.

## Run it

```bash
cp .env.example .env      # then put your key in: openAIAPIKey=sk-...
npm start
```

There are no dependencies to install; it needs Node 18 or newer. The server prints two addresses: one for this computer and one for your iPad on the same Wi‑Fi (e.g. `http://192.168.1.20:3000`). On the iPad, open that address in Safari, then use **Share → Add to Home Screen** for a full-screen app.

## Put it online (HTTPS)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Cpartenio/GalleryWallMaker)

1. Click the button and sign in to Render with GitHub. Free plan; allow Render to access this repo.
2. When asked, fill in **openAIAPIKey** (your OpenAI key) and **appPassword** (any password you like).
3. Deploy. You get a secure `https://gallerywallmaker-xxxx.onrender.com` URL.
4. Open it on the iPad. Safari asks for a username and password: the username can be anything, and the password is your `appPassword`.

The free plan sleeps after about 15 minutes of no use, so the first visit after that takes about 30–60 seconds to wake up.

**Updating:** Render only auto-deploys new pushes when the service is linked through your connected GitHub account. A service made from the public repo link has to be updated by hand: in the Render dashboard, open the service and choose **Manual Deploy → Deploy latest commit**. To get automatic updates, connect GitHub under Render's account settings and create the service via **New → Blueprint**, picking this repo from your GitHub list.

## Host on Firebase (static site + backup eraser)

Erasing normally runs on the visitor's device. Phones that can't manage it (an iPhone running out of memory reloads the page) automatically switch to a **backup eraser**: the same model running in a Firebase Cloud Function that scales to zero.

1. Create a Firebase project and upgrade it to the **Blaze** (pay-as-you-go) plan. Cloud Functions need it, and the free allowance covers a lot of erases.
2. `npm install -g firebase-tools`, then `firebase login`.
3. `cp .firebaserc.example .firebaserc` and put your project ID in it.
4. `cd functions && npm install && cd ..`
5. `firebase deploy`. Hosting serves `public/`, and `/api/fill` goes to the function. The model is copied into the function at deploy time.

No OpenAI key or password is involved: the Firebase version is free for visitors, with photos kept on their device unless the backup eraser is used.

## How it works

1. **Photo**: take or choose a photo of the wall (or tap *Try the sample wall*).
   - *Optional, for real sizes:* tap **🖨 Print the ruler sheet** and tape the page anywhere on the wall, any way up, before taking the photo. The app finds it automatically. It also measures the paper's edges, so it stays accurate even if the printer shrank the page to fit.
2. **Straighten** (optional): if the photo was taken at an angle, drag the 4 dots onto the corners of something rectangular (a big frame), then tap *Straighten*. A magnifier shows what's under your finger.
3. **Mark frames**: frames already on the wall are found automatically and shown as dashed suggestions; adjust or delete them, or drag a box around anything missed. Tap a box to select it, then drag any corner on its own to fit a slanted or odd-shaped frame. Each frame is squared up when it's cut out.
   - **✨ Auto-find on/off** turns the suggestions on or off. Turning it off removes the suggestions you haven't touched.
   - **📏 Ruler sheet on/off** turns the ruler sheet on or off. When it's found, it's outlined in purple and erased along with the frames.
4. **Process**: free and private. An inpainting AI model (MI-GAN) runs right in the browser and fills every marked frame at once, then the fill is blended so the wall's lighting runs seamlessly across each spot. The first time, it downloads the model (~28 MB); the browser keeps it after that. Phones use a lighter setting. If a device can't run it (or the page crashes mid-way), the app brings you back to your marked frames and uses the **backup processing** on the server instead; only a downscaled copy of the photo is sent. If neither is available, a smooth fill is used. The **Processing** button on the Mark step switches between on-device, backup server and (if the server has a key) OpenAI.
5. **Arrange**:
   - Drag frames around. They snap to line up with other frames and with the wall's centre; turn this off with **Snap on/off**.
   - **Layers** opens a strip of thumbnails at the bottom. Tap the eye to hide or show a picture (hidden ones are left out of the saved image), or tap a thumbnail to select it.
   - Frames that were already on the wall keep their **original size** (🔒). Tap *Size locked* to unlock one if you need to.
   - **+ Add picture**: photograph a new piece, drag the 4 dots to its corners (this crops it and fixes any slant), and it's added to the wall. If the scale is known, type its real size (e.g. 16 × 20 in) and it's placed at exactly that size; one number keeps its proportions. Otherwise resize it with the corner dot or a pinch.
   - **Size**: no ruler sheet? Select any frame, tap **Size** and enter its real width and/or height (inches or cm). It becomes the reference and the whole wall is measured from it; the title shows how much wall the photo covers. For pictures you add, **Size** sets their real size. **Sizes** labels every picture with its dimensions.
   - **Ideas** (off by default; set `"ideas": true` in `public/config.json`): finds the biggest open space on the wall, the frame sizes that fit it and the colours already on the wall, then suggests framed art. **Try on wall** places a piece at its real size; **Shop** opens it on Amazon.
   - **↻ Redo wall** regenerates the empty wall if you don't like the result; your arrangement stays put. **Compare** toggles back to the original photo. **Save image** exports the result (iPad share sheet → Save Image).

Works on phones (portrait or landscape), iPad and desktop. Zoom in to place corners precisely: pinch on touch screens; on desktop, Ctrl/⌘ + scroll or a trackpad pinch, scroll to pan, or the − / Fit / + buttons. Desktop keys: Esc deselects, Delete removes the selected box or hides the selected picture, arrow keys nudge (Shift for bigger steps), + / − / 0 zoom.

Your work autosaves in the browser, so a Safari reload won't lose it (*Continue my last wall*).

## Amazon suggestions (Ideas)

- **`public/config.json`**: set `amazonTag` to your Associates tracking ID (e.g. `yourname-20`). Every Amazon link gets it, and the required disclosure line appears in the Ideas panel.
- **Always on**: "shop this size" ideas, i.e. Amazon searches for each frame size that fits, in the wall's colours, with a preview you can try on the wall.
- **Hand-picked products (optional)**: list them in `public/suggestions.json`:
  `[{ "title": "Sage botanical prints, set of 3", "url": "https://www.amazon.com/dp/ASIN", "w": 16, "h": 20, "colors": ["sage", "cream"], "image": null }]`
- **Creators API (when your account qualifies)**: Amazon replaced PA-API 5 with the Creators API, which requires 10 qualifying sales in the past 30 days. Then set `amazonClientId`, `amazonClientSecret` and `amazonPartnerTag` (plus `amazonMarketplace` and `amazonTokenUrl` outside North America) on the server, or in `functions/.env` for Firebase. Ideas will then show real products that fit, with prices.

## Config (`.env`)

| Key | Default | |
|---|---|---|
| `openAIAPIKey` | none | Optional. Adds the OpenAI eraser as an alternative to the free on-device one |
| `openAIImageModel` | `gpt-image-1.5` | Falls back to `gpt-image-1` automatically if your account doesn't have it |
| `openAIImageQuality` | `high` | `low` / `medium` / `high`. Lower is cheaper and faster, but the regenerated wall gets less detailed. |
| `appPassword` | none | If set, the whole site asks for this password (any username). **Set it on any public deploy**, or anyone with the URL can spend your OpenAI credits. |
| `PORT` | `3000` | |

The key stays on the server and is never sent to the browser.

## Notes

- Frame detection, the ruler sheet and erasing all run in the browser. Markers use [js-aruco2](https://github.com/damianofalcioni/js-aruco2) (MIT, vendored in `public/vendor/`).
- Processing runs [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) (Picsart AI Research; code and weights MIT, see `public/models/MI-GAN-LICENSE.txt`) with [ONNX Runtime Web](https://onnxruntime.ai/) (MIT, loaded from jsDelivr) in the browser and `onnxruntime-node` on the server. `public/models/migan_pipeline_v2.onnx` is the official pre-converted pipeline from [huggingface.co/andraniksargsyan/migan](https://huggingface.co/andraniksargsyan/migan) (sha256 `6f1f3530…c48c40b`).
- For offline development, put `ort.min.js`, `ort-wasm-simd-threaded.jsep.mjs` and `ort-wasm-simd-threaded.jsep.wasm` from the `onnxruntime-web@1.30.0` npm package in `public/vendor/ort-local/` (git-ignored).
- `public/ruler-sheet.pdf` is generated by `node scripts/make-ruler-pdf.js`. If you change its layout, update `RULER` in `public/detect.js` to match.
