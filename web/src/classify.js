// Heuristic workflow-type classifier over a graphToPrompt() API-format graph.
// Decides which of the 6 default thumbnails applies when no result is captured,
// and is recorded on every prompt regardless.

const VIDEO_OUT = ["VHS_VideoCombine", "SaveWEBM", "SaveVideo", "SaveAnimatedWEBP", "SaveAnimatedPNG"];
const LOAD_IMAGE = ["LoadImage", "LoadImageMask", "VHS_LoadVideo", "LoadVideo", "LoadVideoFFmpeg"];
const AUDIO_OUT = ["SaveAudio", "SaveAudioMP3", "SaveAudioOpus", "PreviewAudio", "VHS_SaveAudio"];
const SAMPLERS = ["KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced",
  "KSamplerSelect", "SamplerCustomAdvanced"];
const EDIT_HINT = /(Preprocessor|DepthAnything|NormalMap|MaskFromColor|MaskTo|GetMask|ControlNet|Canny|Lineart|OpenPose|SAM|Segment|3D|Hunyuan3D|MeshDecode|Zoe|Midas)/i;
const IMAGE_OUT = /Save(Image|WEBM|AnimatedWEBP|AnimatedPNG)|PreviewImage/i;
const TEXT_OUT = /(Show|Preview|Display).*(Text|String)|Text.*(Show|Preview|Display)/i;

const has = (classes, list) => classes.some((c) => list.includes(c));
const hasRe = (classes, re) => classes.some((c) => re.test(c));

export function classify(output) {
  const classes = Object.values(output || {}).map((n) => n.class_type || "");
  const videoOut = has(classes, VIDEO_OUT);
  const loadImage = has(classes, LOAD_IMAGE);
  const audioOut = has(classes, AUDIO_OUT);
  const sampler = has(classes, SAMPLERS);
  const imageOut = hasRe(classes, IMAGE_OUT);

  if (videoOut) return loadImage ? "v2v" : "t2v";
  if (audioOut) return "audio";
  // Produces no media, only text (LLM / VLLM / prompt-builder) → "other".
  if (!videoOut && !audioOut && !imageOut && hasRe(classes, TEXT_OUT)) return "editing";
  if (!sampler && hasRe(classes, EDIT_HINT)) return "editing";
  if (loadImage) return "i2i";
  return "t2i";
}
