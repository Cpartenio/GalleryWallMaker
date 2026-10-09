# Gallery Wall Maker

Snap a photo of your wall, erase what's hanging, then rearrange it on your iPad, and try new pieces, before you put a single nail in.

## Run it

```bash
cp .env.example .env      # then put your key in: openAIAPIKey=sk-...
npm start
```

There are no dependencies to install; it needs Node 18 or newer. The server prints two addresses: one for this computer and one for your iPad on the same Wi‑Fi (e.g. `http://192.168.1.20:3000`). On the iPad, open that address in Safari, then use **Share → Add to Home Screen** for a full-screen app.

## How it works

1. **Photo**: take or choose a photo of the wall (or tap *Try the sample wall*).
2. **Straighten** (optional): if the photo was taken at an angle, drag the 4 dots onto the corners of something rectangular (a big frame), then tap *Straighten*. A magnifier shows what's under your finger.
3. **Mark frames**: drag a box around each frame. Tap a box to adjust or delete it.
4. **Erase**: the boxes are sent to OpenAI's image edit API, which paints in the empty wall. Only the boxed areas are replaced (colour-matched and feathered), so the rest of the photo stays pixel-exact. Without a key, a simple local wall fill is used instead.
5. **Arrange**:
   - Drag frames around. They snap to line up with other frames and with the wall's centre.
   - Frames that were already on the wall keep their **original size** (🔒). Tap *Size locked* to unlock one if you need to.
   - **+ Add picture**: photograph a new piece, drag the 4 dots to its corners (this crops it and fixes any slant), and it's added to the wall. Resize it with the corner dot or a pinch.
   - **📏 Size**: select an original frame and type its real width in inches to set the scale. After that, every frame shows its size in inches, and you can type an exact width for new pieces.
   - **Compare** toggles back to the original photo. **Save image** exports the result (iPad share sheet → Save Image).

Your work autosaves in the browser, so a Safari reload won't lose it (*Continue my last wall*).

## Config (`.env`)

| Key | Default | |
|---|---|---|
| `openAIAPIKey` | none | Required for AI erasing |
| `openAIImageModel` | `gpt-image-1.5` | Falls back to `gpt-image-1` automatically if your account doesn't have it |
| `openAIImageQuality` | `medium` | `low` / `medium` / `high` |
| `PORT` | `3000` | |

The key stays on the server and is never sent to the browser.
