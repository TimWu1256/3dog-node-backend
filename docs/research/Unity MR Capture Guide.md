# Unity Mixed Reality Capture: Technical Research Guide

**Platform:** Unity + AR Foundation (iOS / Android)  
**Version:** Unity 2022 LTS+, AR Foundation 5.x  
**Scope:** Screen capture strategies, MRC compositing, fallback architecture, Vision API integration

---

## Table of Contents

1. [Overview](#1-overview)
2. [Capture Method Taxonomy](#2-capture-method-taxonomy)
3. [Method Reference](#3-method-reference)
   - 3.1 [ScreenCapture](#31-screencapture)
   - 3.2 [ARFoundation XRCpuImage](#32-arfoundation-xrcpuimage)
   - 3.3 [RenderTexture Composite (MRC)](#33-rendertexture-composite-mrc)
   - 3.4 [AsyncGPUReadback](#34-asyncgpureadback)
   - 3.5 [PhotoCapture](#35-photocapture)
   - 3.6 [Native Camera Plugin](#36-native-camera-plugin)
4. [Industry Best Practice: RenderTexture Composite](#4-industry-best-practice-rendertexture-composite)
5. [Failure Modes Without a Camera](#5-failure-modes-without-a-camera)
6. [Fallback Architecture](#6-fallback-architecture)
   - 6.1 [Design Rationale](#61-design-rationale)
   - 6.2 [Data Structures](#62-data-structures)
   - 6.3 [Strategy Interface](#63-strategy-interface)
   - 6.4 [MRCStrategy](#64-mrcstrategy)
   - 6.5 [VirtualOnlyStrategy](#65-virtualonlystrategy)
   - 6.6 [CaptureManager](#66-capturemanager)
7. [In-Memory Variable Formats](#7-in-memory-variable-formats)
8. [Vision API Integration](#8-vision-api-integration)
9. [Fallback Background Mode Selection](#9-fallback-background-mode-selection)
10. [Security Considerations](#10-security-considerations)
11. [Decision Checklist](#11-decision-checklist)

---

## 1. Overview

Mixed Reality (MR) capture in Unity involves compositing two independent render layers into a single image:

- **Real-world layer** — the physical environment, sourced from the device camera via AR Foundation.
- **Virtual layer** — Unity's 3D scene rendered by the AR camera component.

Neither `ScreenCapture` nor `ARFoundation` alone captures both layers simultaneously. Full **Mixed Reality Capture (MRC)** requires a manual compositing step using `RenderTexture` as an intermediate target.

The resulting image is stored as three in-memory variable formats (`Texture2D`, `byte[]`, `string` Base64) to serve different downstream consumers: image processing pipelines, file I/O, and remote Vision APIs.

---

## 2. Capture Method Taxonomy

| Method                      | Real World | Virtual Objects | Blocks Main Thread | Platform           |
| --------------------------- | :--------: | :-------------: | :----------------: | ------------------ |
| `ScreenCapture`             |     ✗      |        ✓        |        Yes         | All                |
| `ARFoundation XRCpuImage`   |     ✓      |        ✗        |     No (async)     | iOS / Android      |
| **RenderTexture Composite** |   **✓**    |      **✓**      |      Partial       | **All**            |
| `AsyncGPUReadback`          |     ✗      |        ✓        |         No         | All                |
| `PhotoCapture`              |     ✓      |        ✗        |        Yes         | HoloLens / WinMR   |
| `Native Camera Plugin`      |     ✓      |        ✗        |         No         | Platform-dependent |

> **Key takeaway:** Only RenderTexture Composite achieves full MRC (both layers) on cross-platform targets.

---

## 3. Method Reference

### 3.1 ScreenCapture

Unity's built-in API. Reads the composed frame buffer after all post-processing but **before** the physical camera feed is overlaid at the OS level. AR Foundation renders the camera feed on a background plane inside the Unity scene, so whether that plane is visible in the capture depends on your AR Foundation setup version and render pipeline.

```csharp
IEnumerator SimpleCaptureCoroutine()
{
    yield return new WaitForEndOfFrame();
    Texture2D tex = ScreenCapture.CaptureScreenshotAsTexture();
    byte[] bytes   = tex.EncodeToJPG();
    string base64  = Convert.ToBase64String(bytes);
}
```

**Use when:** Debug captures, UI screenshots, no real-world content needed.  
**Do not use when:** MRC output is required, or when camera feed rendering is handled outside Unity's scene graph.

---

### 3.2 ARFoundation XRCpuImage

Direct access to raw camera frames from the CPU buffer. Non-blocking via async conversion. Produces the highest-fidelity real-world image because it bypasses Unity's render pipeline entirely.

```csharp
void OnCameraFrameReceived(ARCameraFrameEventArgs args)
{
    if (!arCameraManager.TryAcquireLatestCpuImage(out XRCpuImage image)) return;
    using (image)
    {
        var convParams = new XRCpuImage.ConversionParams
        {
            inputRect        = new RectInt(0, 0, image.width, image.height),
            outputDimensions = new Vector2Int(image.width, image.height),
            outputFormat     = TextureFormat.RGBA32,
            transformation   = XRCpuImage.Transformation.MirrorY
        };
        image.ConvertAsync(convParams, OnConversionComplete);
    }
}
```

**Use when:** Real-world-only processing (e.g., object detection, scene reconstruction). Lowest overhead for camera-feed extraction.  
**Limitation:** No virtual objects in the output. Must be combined with a compositing step for MRC.

---

### 3.3 RenderTexture Composite (MRC)

The industry standard for mixed reality capture. Blits the AR camera CPU image as a background into a `RenderTexture`, then renders the Unity scene (virtual objects) on top.

**Pipeline:**

```
XRCpuImage (real world)
    └─ Graphics.Blit ──► RenderTexture ◄── arCamera.Render() (virtual)
                               │
                         ReadPixels()
                               │
                          Texture2D ──► byte[] ──► Base64
```

**Use when:** Full MRC output is required. Cross-platform deployment. Output is destined for Vision APIs, image processing, or user-facing preview.

---

### 3.4 AsyncGPUReadback

Non-blocking GPU readback. The GPU renders to a `RenderTexture`; the result is returned asynchronously via a callback, avoiding the stall that `Texture2D.ReadPixels()` causes.

```csharp
public void CaptureAsync()
{
    var rt = new RenderTexture(Screen.width, Screen.height, 24);
    arCamera.targetTexture = rt;
    arCamera.Render();
    arCamera.targetTexture = null;
    AsyncGPUReadback.Request(rt, 0, TextureFormat.RGB24, OnReadbackComplete);
}

void OnReadbackComplete(AsyncGPUReadbackRequest req)
{
    if (req.hasError) return;
    var data = req.GetData<byte>();
    capturedTexture = new Texture2D(Screen.width, Screen.height, TextureFormat.RGB24, false);
    capturedTexture.LoadRawTextureData(data);
    capturedTexture.Apply();
}
```

**Use when:** Performance-critical applications (60 fps AR experiences) where main-thread stalls are unacceptable.  
**Note:** Can be combined with the MRC compositing approach by requesting readback after the full composite is rendered into the `RenderTexture`.

---

### 3.5 PhotoCapture

Microsoft's `UnityEngine.Windows.WebCam.PhotoCapture` API. Captures a full-resolution photo from the device camera synchronously.

**Use when:** HoloLens / Windows Mixed Reality exclusive targets.  
**Do not use for:** iOS / Android targets — the API is not available.

---

### 3.6 Native Camera Plugin

Third-party plugins (e.g., NatCamera, OpenCV for Unity) that bridge to the platform's native camera APIs directly. Provides access to camera features unavailable through AR Foundation: RAW formats, manual exposure, multi-camera switching.

**Use when:** Maximum image quality is required, or camera features beyond AR Foundation's abstraction are needed.  
**Trade-off:** Adds a dependency, may lag behind OS updates, requires plugin licensing.

---

## 4. Industry Best Practice: RenderTexture Composite

### Why RenderTexture Composite is Preferred

1. **Cross-platform** — Works on iOS, Android, and editor. No platform-specific API surface.
2. **Full MRC** — Both real-world and virtual layers are captured in a single composited image.
3. **Deterministic timing** — `WaitForEndOfFrame` guarantees capture occurs after GPU rendering completes, preventing partial-frame artifacts.
4. **Format flexibility** — A single capture operation populates `Texture2D`, `byte[]`, and Base64 simultaneously, serving all downstream consumers without re-encoding.
5. **Compositing control** — The intermediate `RenderTexture` can receive additional post-processing (e.g., depth masking, color grading) before the final readback.

### Timing Requirement

`ReadPixels` must be called within a `WaitForEndOfFrame` coroutine. Calling it outside this yield point reads a partial or stale frame buffer.

```csharp
// Correct
IEnumerator Capture()
{
    yield return new WaitForEndOfFrame();
    // ReadPixels here is safe
}

// Incorrect — reads a frame that may not be fully rendered
void Update()
{
    texture.ReadPixels(...); // Do NOT do this
}
```

---

## 5. Failure Modes Without a Camera

When `arCamera` or `_cameraFeedTexture` is unavailable, the compositing pipeline degrades in distinct ways depending on where the null occurs.

| Condition                                      | Behaviour                                                                     | Crash? |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | :----: |
| `arCamera == null`                             | `NullReferenceException` on `.Render()`                                       |  Yes   |
| `arCamera` exists, AR session not yet tracking | `_cameraFeedTexture` is null; background is black or `clearColor`             |   No   |
| `_cameraFeedTexture == null`, `Blit` guarded   | Only virtual objects rendered; background is `clearColor`                     |   No   |
| `arCamera.enabled == false`                    | `Render()` executes but produces undefined output (may be last frame residue) |   No   |

### Required Guards

```csharp
// Guard 1: camera object must exist
if (arCamera == null)
{
    Debug.LogError("[CaptureManager] arCamera not assigned.");
    onComplete?.Invoke(null);
    yield break;
}

// Guard 2: log AR session state for diagnostics
if (ARSession.state < ARSessionState.SessionTracking)
    Debug.LogWarning($"[CaptureManager] AR session not yet tracking: {ARSession.state}");

// Guard 3: camera feed texture
if (_cameraFeedTexture != null)
    Graphics.Blit(_cameraFeedTexture, rt);
else
    ApplyFallbackBackground(rt);
```

---

## 6. Fallback Architecture

### 6.1 Design Rationale

The fallback is designed using the **Strategy Pattern**. The `CaptureManager` detects camera availability at capture time and selects the appropriate strategy automatically. The calling code always invokes `captureManager.Capture()` — it does not branch on camera state.

This separation of concerns means:

- Adding a new background mode requires only a new `BackgroundMode` enum value and a corresponding branch in `VirtualOnlyStrategy`.
- Swapping the MRC implementation requires only changing `MRCStrategy`.
- The `CaptureManager` and all calling code remain unchanged.

---

### 6.2 Data Structures

```csharp
public enum CaptureMode
{
    FullMRC,        // Real world + virtual objects composited
    VirtualOnly     // No camera feed available; fallback path taken
}

public enum BackgroundMode
{
    ClearColor,     // Respect Camera.clearFlags (skybox or solid color)
    SolidColor,     // Flat color fill (configurable; default dark gray)
    CustomTexture,  // User-supplied Texture2D as background
    ChromaKey       // Pure green (#00FF00) for post-production keying
}

public class CaptureResult
{
    public Texture2D   texture;       // For display or local image processing
    public byte[]      bytes;         // For file I/O
    public string      base64;        // For HTTP API payloads
    public bool        hasRealWorld;  // False when fallback path was taken
    public CaptureMode mode;          // Indicates which strategy was used
}
```

---

### 6.3 Strategy Interface

```csharp
public interface ICaptureStrategy
{
    /// <summary>
    /// Fills <paramref name="rt"/> with the background and renders
    /// virtual objects. Invokes <paramref name="onDone"/> with
    /// hasRealWorld = true if real-world content was composited.
    /// </summary>
    IEnumerator Execute(RenderTexture rt, Camera cam, Action<bool> onDone);
}
```

---

### 6.4 MRCStrategy

Full mixed reality composite. Used when `_cameraFeedTexture` is available.

```csharp
public class MRCStrategy : ICaptureStrategy
{
    private readonly Texture2D _cameraFeed;

    public MRCStrategy(Texture2D cameraFeed) => _cameraFeed = cameraFeed;

    public IEnumerator Execute(RenderTexture rt, Camera cam, Action<bool> onDone)
    {
        // Layer 1: real-world background
        Graphics.Blit(_cameraFeed, rt);

        // Layer 2: virtual objects on top
        cam.targetTexture = rt;
        cam.Render();
        cam.targetTexture = null;

        onDone(true);
        yield break;
    }
}
```

---

### 6.5 VirtualOnlyStrategy

Fallback path. Fills a configurable background then renders virtual objects.

```csharp
public class VirtualOnlyStrategy : ICaptureStrategy
{
    private readonly BackgroundMode _mode;
    private readonly Color          _solidColor;
    private readonly Texture2D      _customTexture;

    public VirtualOnlyStrategy(
        BackgroundMode mode,
        Color?    color   = null,
        Texture2D texture = null)
    {
        _mode          = mode;
        _solidColor    = color ?? new Color(0.12f, 0.12f, 0.12f);
        _customTexture = texture;
    }

    public IEnumerator Execute(RenderTexture rt, Camera cam, Action<bool> onDone)
    {
        switch (_mode)
        {
            case BackgroundMode.SolidColor:
                FillSolid(rt, _solidColor);
                break;

            case BackgroundMode.ChromaKey:
                FillSolid(rt, new Color(0f, 1f, 0f));
                break;

            case BackgroundMode.CustomTexture:
                if (_customTexture != null)
                    Graphics.Blit(_customTexture, rt);
                else
                    FillSolid(rt, _solidColor);     // degrade gracefully
                break;

            case BackgroundMode.ClearColor:
            default:
                break;                              // respect Camera.clearFlags
        }

        cam.targetTexture = rt;
        cam.Render();
        cam.targetTexture = null;

        onDone(false);
        yield break;
    }

    private static void FillSolid(RenderTexture rt, Color color)
    {
        var mat = new Material(Shader.Find("Unlit/Color"));
        mat.color = color;
        Graphics.Blit(null, rt, mat);
        Object.Destroy(mat);
    }
}
```

---

### 6.6 CaptureManager

Unified entry point. Subscribes to AR camera frames, maintains the camera feed texture, and dispatches the correct strategy at capture time.

```csharp
public class CaptureManager : MonoBehaviour
{
    [Header("AR Components")]
    public ARCameraManager arCameraManager;
    public Camera          arCamera;

    [Header("Fallback Configuration")]
    public BackgroundMode fallbackMode    = BackgroundMode.SolidColor;
    public Color          fallbackColor   = new Color(0.12f, 0.12f, 0.12f);
    public Texture2D      fallbackTexture;

    /// <summary>
    /// The most recent capture result. Populated after each successful Capture() call.
    /// Access .base64 to send to a Vision API, .texture for local rendering,
    /// or .bytes for file I/O.
    /// </summary>
    public CaptureResult LastResult { get; private set; }

    private Texture2D _cameraFeedTexture;

    void OnEnable()  => arCameraManager.frameReceived += OnCameraFrame;
    void OnDisable() => arCameraManager.frameReceived -= OnCameraFrame;

    private void OnCameraFrame(ARCameraFrameEventArgs _)
    {
        if (!arCameraManager.TryAcquireLatestCpuImage(out var img)) return;
        using (img)
        {
            var p = new XRCpuImage.ConversionParams
            {
                inputRect        = new RectInt(0, 0, img.width, img.height),
                outputDimensions = new Vector2Int(img.width, img.height),
                outputFormat     = TextureFormat.RGBA32,
                transformation   = XRCpuImage.Transformation.MirrorY
            };
            if (_cameraFeedTexture == null)
                _cameraFeedTexture = new Texture2D(
                    img.width, img.height, TextureFormat.RGBA32, false);

            var buf = new NativeArray<byte>(
                img.GetConvertedDataSize(p), Allocator.Temp);
            img.Convert(p, buf);
            _cameraFeedTexture.LoadRawTextureData(buf);
            _cameraFeedTexture.Apply();
            buf.Dispose();
        }
    }

    public IEnumerator Capture(Action<CaptureResult> onComplete = null)
    {
        if (arCamera == null)
        {
            Debug.LogError("[CaptureManager] arCamera is not assigned.");
            onComplete?.Invoke(null);
            yield break;
        }

        if (ARSession.state < ARSessionState.SessionTracking)
            Debug.LogWarning(
                $"[CaptureManager] AR session not tracking ({ARSession.state}). " +
                "Camera feed may be unavailable.");

        yield return new WaitForEndOfFrame();

        int w = Screen.width, h = Screen.height;
        var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);

        // Strategy selection — automatic, transparent to the caller
        ICaptureStrategy strategy = (_cameraFeedTexture != null)
            ? (ICaptureStrategy) new MRCStrategy(_cameraFeedTexture)
            : new VirtualOnlyStrategy(fallbackMode, fallbackColor, fallbackTexture);

        bool hasReal = false;
        yield return StartCoroutine(strategy.Execute(rt, arCamera, r => hasReal = r));

        var prev = RenderTexture.active;
        RenderTexture.active = rt;
        var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
        tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
        tex.Apply();
        RenderTexture.active = prev;
        rt.Release();

        var bytes = tex.EncodeToJPG(quality: 85);
        LastResult = new CaptureResult
        {
            texture      = tex,
            bytes        = bytes,
            base64       = Convert.ToBase64String(bytes),
            hasRealWorld = hasReal,
            mode         = hasReal ? CaptureMode.FullMRC : CaptureMode.VirtualOnly
        };

        Debug.Log(
            $"[CaptureManager] Captured {w}×{h} | " +
            $"Mode: {LastResult.mode} | " +
            $"Base64 length: {LastResult.base64.Length}");

        onComplete?.Invoke(LastResult);
    }
}
```

---

## 7. In-Memory Variable Formats

A single `Capture()` call populates three representations of the same image. Store all three; do not re-encode on demand.

| Property                  | Type          | Primary Use                                          |
| ------------------------- | ------------- | ---------------------------------------------------- |
| `LastResult.texture`      | `Texture2D`   | UI preview, local image processing (OpenCV, etc.)    |
| `LastResult.bytes`        | `byte[]`      | Writing to disk (`File.WriteAllBytes`)               |
| `LastResult.base64`       | `string`      | HTTP API payloads (Vision APIs, multipart form data) |
| `LastResult.hasRealWorld` | `bool`        | Conditional prompt construction, capture validation  |
| `LastResult.mode`         | `CaptureMode` | Logging, analytics, downstream routing               |

---

## 8. Vision API Integration

After calling `CaptureManager.Capture()`, `LastResult.base64` can be sent directly to a Vision API. The example below targets the Anthropic Messages API.

```csharp
IEnumerator SendToVisionAPI()
{
    // Step 1: capture
    yield return StartCoroutine(captureManager.Capture());

    var result = captureManager.LastResult;
    if (result == null) yield break;

    // Step 2: adapt prompt based on capture mode
    string prompt = result.hasRealWorld
        ? "Describe both the real-world environment and the virtual objects in this MR screenshot."
        : "This screenshot contains only virtual objects. Describe the 3D content in the scene.";

    // Step 3: build payload using the stored base64 variable
    string payload = JsonUtility.ToJson(new AnthropicRequest
    {
        model      = "claude-opus-4-5",
        max_tokens = 1024,
        messages   = new[] {
            new Message {
                role    = "user",
                content = new object[] {
                    new { type = "image", source = new {
                        type       = "base64",
                        media_type = "image/jpeg",
                        data       = result.base64        // ← stored variable
                    }},
                    new { type = "text", text = prompt }
                }
            }
        }
    });

    // Step 4: send
    var req = new UnityWebRequest("https://api.anthropic.com/v1/messages", "POST");
    req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(payload));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("Content-Type",      "application/json");
    req.SetRequestHeader("x-api-key",         apiKey);
    req.SetRequestHeader("anthropic-version", "2023-06-01");

    yield return req.SendWebRequest();

    if (req.result == UnityWebRequest.Result.Success)
        Debug.Log(req.downloadHandler.text);
    else
        Debug.LogError(req.error);
}
```

> **Security note:** Never embed the API key in client-side Unity builds. The key is extractable from compiled APK/IPA files. Route API calls through a backend proxy that authenticates the client and injects the key server-side.

---

## 9. Fallback Background Mode Selection

| Mode            | Visual Result                                                                   | Recommended For                                                      |
| --------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ClearColor`    | Follows `Camera.clearFlags` (skybox or solid color set in the camera component) | Editor testing; scene already has a designed background              |
| `SolidColor`    | Flat color fill (default: dark gray `#1E1E1E`)                                  | Screenshot previews, UI-heavy scenes, debug builds                   |
| `CustomTexture` | User-supplied `Texture2D` as background                                         | Simulated environment images during development; branded backgrounds |
| `ChromaKey`     | Pure green (`#00FF00`)                                                          | Post-production video compositing; downstream keying pipelines       |

If `CustomTexture` is selected but no texture is assigned, `VirtualOnlyStrategy` degrades to `SolidColor` without throwing an exception.

---

## 10. Security Considerations

| Concern                       | Recommendation                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API key exposure              | Never store in client build. Use a backend proxy or server-side signed URL.                                                                                              |
| Screenshot data leakage       | Treat `CaptureResult.base64` as sensitive data. Clear `LastResult` after use if the scene contains private information.                                                  |
| Camera permission             | Declare `NSCameraUsageDescription` (iOS) and `CAMERA` permission (Android) in the project manifest. AR Foundation will not initialise without these.                     |
| JPEG quality vs. payload size | 85% JPEG quality is a reasonable default. For Vision APIs with payload size limits (e.g., 5 MB), reduce quality or scale the `RenderTexture` dimensions before encoding. |

---

## 11. Decision Checklist

Use this checklist when implementing or reviewing a capture feature:

- [ ] Is `arCamera` validated for null before calling `.Render()`?
- [ ] Is the capture coroutine yielding `WaitForEndOfFrame` before `ReadPixels`?
- [ ] Is `_cameraFeedTexture` null-guarded before `Graphics.Blit`?
- [ ] Is `RenderTexture.active` restored after `ReadPixels`?
- [ ] Is `rt.Release()` called after the readback to free GPU memory?
- [ ] Are all three output formats (`texture`, `bytes`, `base64`) populated in one pass?
- [ ] Does `CaptureResult.hasRealWorld` correctly reflect the path taken?
- [ ] Is the API key stored server-side, not in the client build?
- [ ] Has `BackgroundMode` been selected to match the intended downstream use of the fallback image?
- [ ] Are camera permissions declared in the platform manifest?

---

_Document prepared from technical research on Unity AR Foundation MR capture strategies._  
_Last updated: 2026-03_
