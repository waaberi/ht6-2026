export type Id = string;

export type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
  polygon?: Array<{ x: number; y: number }>;
  polyline?: Array<{ x: number; y: number }>;
  maskAssetId?: Id;
};

export type AdjustmentValues = Partial<{
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  temperature: number;
  tint: number;
  saturation: number;
  vibrance: number;
  sharpening: number;
  denoise: number;
  grain: number;
  vignette: number;
}>;

export type CanvasTransform = {
  crop?: Region;
  rotationDegrees: number;
  perspective: [number, number, number, number, number, number, number, number, number];
  expansion?: { top: number; right: number; bottom: number; left: number };
};

export const identityCanvasTransform = (): CanvasTransform => ({
  rotationDegrees: 0,
  perspective: [1, 0, 0, 0, 1, 0, 0, 0, 1],
});

type LayerBase = {
  id: Id;
  name: string;
  enabled: boolean;
  opacity: number;
  createdAt: string;
};

export type AdjustmentLayer = LayerBase & {
  type: 'adjustment';
  adjustments: AdjustmentValues;
};

export type MaskedAdjustmentLayer = LayerBase & {
  type: 'masked-adjustment';
  adjustments: AdjustmentValues;
  mask: { type: 'subject' | 'polygon' | 'color-range' | 'painted'; region?: Region; assetId?: Id; uri?: string };
};

export type ImageLayer = LayerBase & {
  type: 'image';
  assetId: Id;
  uri: string;
  transform: CanvasTransform;
  blendMode: 'normal' | 'multiply' | 'screen' | 'overlay';
  maskAssetId?: Id;
};

export type RetouchLayer = LayerBase & {
  type: 'retouch';
  patchAssetId: Id;
  patchUri: string;
  maskAssetId: Id;
  maskUri?: string;
  target: Region;
  provenance: { method: 'clone' | 'heal' | 'generated'; prompt?: string; model?: string };
};

export type GenerativePatchLayer = LayerBase & {
  type: 'generative-patch';
  patchAssetId: Id;
  patchUri: string;
  maskAssetId: Id;
  maskUri?: string;
  target: Region;
  prompt: string;
  provenance: { model: string; sourceVersionId: Id; driftScore: number };
};

export type StyleLayer = LayerBase & {
  type: 'style';
  styleProfileId: Id;
  adjustments: AdjustmentValues;
  strength: number;
};

export type Layer =
  | AdjustmentLayer
  | MaskedAdjustmentLayer
  | ImageLayer
  | RetouchLayer
  | GenerativePatchLayer
  | StyleLayer;

export type LayerStack = {
  canvasTransform: CanvasTransform;
  layers: Layer[];
};

export type PhotoVersion = {
  id: Id;
  photoId: Id;
  parentVersionId?: Id;
  restoredFromVersionId?: Id;
  createdAt: string;
  label: string;
  stack: LayerStack;
};

export type PhotoRecord = {
  id: Id;
  createdAt: string;
  captureSource: 'camera' | 'library' | 'document' | 'usb';
  originalUri: string;
  originalName: string;
  originalMimeType: string;
  originalByteSize: number;
  originalChecksum: string;
  analysisProxyUri: string;
  thumbnailUri: string;
  width?: number;
  height?: number;
  exif: Record<string, unknown>;
  currentVersionId: Id;
  versions: PhotoVersion[];
  syncState: 'local' | 'queued' | 'syncing' | 'synced' | 'failed';
};

export type IssueCategory =
  | 'composition'
  | 'focus'
  | 'color'
  | 'lighting'
  | 'distraction'
  | 'intent'
  | 'metadata';

export type Issue = {
  id: Id;
  category: IssueCategory;
  title: string;
  explanation: string;
  evidence: Record<string, number | string | boolean | null>;
  severity: number;
  confidence: number;
  location: Region;
  recommendedAction: string;
  fix?: {
    kind: 'adjustment' | 'masked-adjustment' | 'transform' | 'crop' | 'retouch' | 'generative' | 'retake';
    adjustments?: AdjustmentValues;
    canvasTransform?: Partial<CanvasTransform>;
  };
};

export type LightingAnalysis = {
  exposure: number;
  contrast: number;
  clippedShadows: number;
  clippedHighlights: number;
  colorCast: { red: number; green: number; blue: number };
};

export type CameraRecommendation = {
  setting: 'iso' | 'aperture' | 'shutter' | 'focal-length' | 'distance' | 'stability' | 'lighting';
  value?: string;
  explanation: string;
  basedOn: string[];
};

export type AnalysisResult = {
  versionId: Id;
  checksum: string;
  createdAt: string;
  deterministicModel: string;
  semanticModel?: string;
  metrics: Record<string, number | string | boolean | null>;
  lighting: LightingAnalysis;
  issues: Issue[];
  cameraRecommendations: CameraRecommendation[];
  summary: string;
};
