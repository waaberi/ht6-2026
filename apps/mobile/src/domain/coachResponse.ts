import type {
  AdjustmentValues,
  CanvasTransform,
  CoachAction,
  CoachCaptureAdvice,
  CoachEvidence,
  CoachResponse,
  CoachTool,
  Region,
} from './types';

type JsonRecord = Record<string, unknown>;
type ParsedCoachAction = CoachAction & { expansionFraction?: number };

const COACH_TOOLS = [
  'adjust_global',
  'adjust_masked',
  'crop',
  'straighten',
  'remove',
  'add',
  'expand',
  'retake',
] as const satisfies readonly CoachTool[];

const ADJUSTMENT_KEYS = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'temperature',
  'tint',
  'saturation',
  'vibrance',
  'sharpening',
  'denoise',
  'grain',
  'vignette',
] as const satisfies ReadonlyArray<keyof AdjustmentValues>;

const CAPTURE_SETTINGS = [
  'iso',
  'aperture',
  'shutter',
  'focal-length',
  'distance',
  'stability',
  'lighting',
] as const satisfies readonly CoachCaptureAdvice['setting'][];

const CANVAS_SIDES = ['top', 'right', 'bottom', 'left'] as const;

export class InvalidCoachResponseError extends Error {
  constructor(message: string) {
    super(`Invalid Coach response: ${message}`);
    this.name = 'InvalidCoachResponseError';
  }
}

const invalid = (path: string, expectation: string): never => {
  throw new InvalidCoachResponseError(`${path} ${expectation}.`);
};

const record = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'must be an object');
  }
  return value as JsonRecord;
};

const knownKeys = (value: JsonRecord, allowed: readonly string[], path: string) => {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) invalid(`${path}.${unexpected}`, 'is not supported');
};

const array = (value: unknown, path: string, maxLength: number): unknown[] => {
  if (!Array.isArray(value)) return invalid(path, 'must be an array');
  if (value.length > maxLength) return invalid(path, `must contain at most ${maxLength} items`);
  return value;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !value.trim()) return invalid(path, 'must be a non-empty string');
  return value;
};

const conciseString = (value: unknown, path: string, maximumWords: number): string => {
  const parsed = string(value, path);
  if (parsed.trim().split(/\s+/).length > maximumWords) {
    invalid(path, `must contain at most ${maximumWords} words`);
  }
  return parsed;
};

const optionalString = (value: unknown, path: string): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return string(value, path);
};

const finiteNumber = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(path, 'must be a finite number');
  return value;
};

const boundedNumber = (value: unknown, minimum: number, maximum: number, path: string): number => {
  const parsed = finiteNumber(value, path);
  if (parsed < minimum || parsed > maximum) invalid(path, `must be between ${minimum} and ${maximum}`);
  return parsed;
};

const positiveNormalizedNumber = (value: unknown, path: string): number => {
  const parsed = finiteNumber(value, path);
  if (parsed <= 0 || parsed > 1) invalid(path, 'must be greater than 0 and at most 1');
  return parsed;
};

const normalizedPoint = (value: unknown, path: string): { x: number; y: number } => {
  const point = record(value, path);
  knownKeys(point, ['x', 'y'], path);
  return {
    x: boundedNumber(point.x, 0, 1, `${path}.x`),
    y: boundedNumber(point.y, 0, 1, `${path}.y`),
  };
};

const region = (value: unknown, path: string): Region => {
  const source = record(value, path);
  knownKeys(source, ['x', 'y', 'width', 'height', 'polygon', 'polyline', 'maskAssetId'], path);
  const x = boundedNumber(source.x, 0, 1, `${path}.x`);
  const y = boundedNumber(source.y, 0, 1, `${path}.y`);
  const width = positiveNormalizedNumber(source.width, `${path}.width`);
  const height = positiveNormalizedNumber(source.height, `${path}.height`);
  if (x + width > 1 + 1e-9 || y + height > 1 + 1e-9) {
    invalid(path, 'must remain inside normalized image bounds');
  }

  const polygon = source.polygon == null
    ? undefined
    : array(source.polygon, `${path}.polygon`, 10_000).map((point, index) => normalizedPoint(point, `${path}.polygon[${index}]`));
  const polyline = source.polyline == null
    ? undefined
    : array(source.polyline, `${path}.polyline`, 10_000).map((point, index) => normalizedPoint(point, `${path}.polyline[${index}]`));
  const maskAssetId = optionalString(source.maskAssetId, `${path}.maskAssetId`);

  return {
    x,
    y,
    width,
    height,
    ...(polygon ? { polygon } : {}),
    ...(polyline ? { polyline } : {}),
    ...(maskAssetId ? { maskAssetId } : {}),
  };
};

const adjustments = (value: unknown, path: string): AdjustmentValues => {
  const source = record(value, path);
  knownKeys(source, ADJUSTMENT_KEYS, path);
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    result[key] = boundedNumber(raw, -1, 1, `${path}.${key}`);
  }
  if (!Object.keys(result).length) invalid(path, 'must include at least one adjustment');
  return result as AdjustmentValues;
};

const canvasTransform = (value: unknown, path: string): Partial<CanvasTransform> => {
  const source = record(value, path);
  knownKeys(source, ['crop', 'rotationDegrees', 'perspective', 'expansion'], path);
  const crop = source.crop == null ? undefined : region(source.crop, `${path}.crop`);
  const rotationDegrees = source.rotationDegrees == null
    ? undefined
    : boundedNumber(source.rotationDegrees, -45, 45, `${path}.rotationDegrees`);
  const perspective = source.perspective == null
    ? undefined
    : array(source.perspective, `${path}.perspective`, 9).map((entry, index) => (
        finiteNumber(entry, `${path}.perspective[${index}]`)
      ));
  if (perspective && perspective.length !== 9) invalid(`${path}.perspective`, 'must contain exactly 9 numbers');

  let expansion: CanvasTransform['expansion'] | undefined;
  if (source.expansion != null) {
    const rawExpansion = record(source.expansion, `${path}.expansion`);
    knownKeys(rawExpansion, CANVAS_SIDES, `${path}.expansion`);
    if (CANVAS_SIDES.some((side) => rawExpansion[side] === undefined || rawExpansion[side] === null)) {
      invalid(`${path}.expansion`, 'must include top, right, bottom, and left');
    }
    expansion = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const side of CANVAS_SIDES) {
      expansion[side] = boundedNumber(rawExpansion[side], 0, Number.MAX_SAFE_INTEGER, `${path}.expansion.${side}`);
    }
  }

  if (!crop && rotationDegrees === undefined && !perspective && !expansion) {
    invalid(path, 'must include a crop, rotation, perspective, or expansion');
  }
  return {
    ...(crop ? { crop } : {}),
    ...(rotationDegrees !== undefined ? { rotationDegrees } : {}),
    ...(perspective ? { perspective: perspective as CanvasTransform['perspective'] } : {}),
    ...(expansion ? { expansion } : {}),
  };
};

const coachEvidence = (value: unknown, path: string): CoachEvidence => {
  const source = record(value, path);
  knownKeys(source, ['path', 'value', 'meaning'], path);
  const rawValue = source.value;
  let parsedValue: string | number | boolean | null | undefined;
  if (rawValue !== null && rawValue !== undefined) {
    if (typeof rawValue === 'number') parsedValue = finiteNumber(rawValue, `${path}.value`);
    else if (typeof rawValue === 'string' || typeof rawValue === 'boolean') parsedValue = rawValue;
    else invalid(`${path}.value`, 'must be a string, number, boolean, or null');
  } else if (rawValue === null) {
    parsedValue = null;
  }
  return {
    path: string(source.path, `${path}.path`),
    meaning: conciseString(source.meaning, `${path}.meaning`, 18),
    ...(parsedValue !== undefined ? { value: parsedValue } : {}),
  };
};

const captureAdvice = (value: unknown, path: string): CoachCaptureAdvice => {
  const source = record(value, path);
  knownKeys(source, ['setting', 'value', 'tradeoff', 'basedOn'], path);
  if (!CAPTURE_SETTINGS.includes(source.setting as CoachCaptureAdvice['setting'])) {
    invalid(`${path}.setting`, 'must be a supported camera setting');
  }
  const valueText = optionalString(source.value, `${path}.value`);
  const tradeoff = source.tradeoff == null
    ? undefined
    : conciseString(source.tradeoff, `${path}.tradeoff`, 20);
  const basedOn = array(source.basedOn, `${path}.basedOn`, 6)
    .map((entry, index) => string(entry, `${path}.basedOn[${index}]`));
  if (!basedOn.length) invalid(`${path}.basedOn`, 'must contain at least one evidence path');
  return {
    setting: source.setting as CoachCaptureAdvice['setting'],
    basedOn,
    ...(valueText ? { value: valueText } : {}),
    ...(tradeoff ? { tradeoff } : {}),
  };
};

const coachAction = (value: unknown, path: string): ParsedCoachAction => {
  const source = record(value, path);
  knownKeys(source, [
    'id',
    'tool',
    'label',
    'reason',
    'basedOn',
    'requiresConfirmation',
    'adjustments',
    'target',
    'prompt',
    'canvasTransform',
    'expansionFraction',
  ], path);
  if (!COACH_TOOLS.includes(source.tool as CoachTool)) invalid(`${path}.tool`, 'must be a supported Coach tool');
  if (source.requiresConfirmation !== true) invalid(`${path}.requiresConfirmation`, 'must be true');

  const tool = source.tool as CoachTool;
  const basedOn = array(source.basedOn, `${path}.basedOn`, 4)
    .map((entry, index) => string(entry, `${path}.basedOn[${index}]`));
  if (!basedOn.length) invalid(`${path}.basedOn`, 'must contain at least one evidence path');
  const parsedAdjustments = source.adjustments == null ? undefined : adjustments(source.adjustments, `${path}.adjustments`);
  const target = source.target == null ? undefined : region(source.target, `${path}.target`);
  const prompt = optionalString(source.prompt, `${path}.prompt`);
  const transform = source.canvasTransform == null ? undefined : canvasTransform(source.canvasTransform, `${path}.canvasTransform`);
  const expansionFraction = source.expansionFraction == null
    ? undefined
    : boundedNumber(source.expansionFraction, 0.1, 0.5, `${path}.expansionFraction`);

  if ((tool === 'adjust_global' || tool === 'adjust_masked') !== Boolean(parsedAdjustments)) {
    invalid(`${path}.adjustments`, `must be present only for ${tool === 'adjust_global' || tool === 'adjust_masked' ? tool : 'adjustment tools'}`);
  }
  if (tool === 'adjust_masked' && !target) invalid(`${path}.target`, 'is required for adjust_masked');
  if ((tool === 'remove' || tool === 'add') && !target) invalid(`${path}.target`, `is required for ${tool}`);
  if (!['adjust_masked', 'remove', 'add'].includes(tool) && target) invalid(`${path}.target`, `is not valid for ${tool}`);
  if (tool === 'add' && !prompt) invalid(`${path}.prompt`, 'is required for add');
  if (!['remove', 'add', 'expand'].includes(tool) && prompt) invalid(`${path}.prompt`, `is not valid for ${tool}`);

  if (tool === 'crop' && !transform?.crop) invalid(`${path}.canvasTransform.crop`, 'is required for crop');
  if (tool === 'crop' && transform && Object.keys(transform).some((key) => key !== 'crop')) {
    invalid(`${path}.canvasTransform`, 'may contain only crop for crop');
  }
  if (tool === 'straighten' && transform?.rotationDegrees === undefined) {
    invalid(`${path}.canvasTransform.rotationDegrees`, 'is required for straighten');
  }
  if (tool === 'straighten' && transform && Object.keys(transform).some((key) => key !== 'rotationDegrees')) {
    invalid(`${path}.canvasTransform`, 'may contain only rotationDegrees for straighten');
  }
  if (tool === 'expand') {
    const expansion = transform?.expansion;
    const positiveSides = expansion ? CANVAS_SIDES.filter((side) => expansion[side] > 0) : [];
    if (transform && Object.keys(transform).some((key) => key !== 'expansion')) {
      invalid(`${path}.canvasTransform`, 'may contain only expansion for expand');
    }
    if (positiveSides.length !== 1) invalid(`${path}.canvasTransform.expansion`, 'must select exactly one positive edge for expand');
    if (expansionFraction === undefined) invalid(`${path}.expansionFraction`, 'is required for expand');
  } else if (expansionFraction !== undefined) {
    invalid(`${path}.expansionFraction`, 'is only valid for expand');
  }
  if (!['crop', 'straighten', 'expand'].includes(tool) && transform) {
    invalid(`${path}.canvasTransform`, `is not valid for ${tool}`);
  }

  return {
    id: string(source.id, `${path}.id`),
    tool,
    label: conciseString(source.label, `${path}.label`, 6),
    reason: conciseString(source.reason, `${path}.reason`, 20),
    basedOn,
    requiresConfirmation: true,
    ...(parsedAdjustments ? { adjustments: parsedAdjustments } : {}),
    ...(target ? { target } : {}),
    ...(prompt ? { prompt } : {}),
    ...(transform ? { canvasTransform: transform } : {}),
    ...(expansionFraction !== undefined ? { expansionFraction } : {}),
  };
};

export const parseCoachResponse = (value: unknown): CoachResponse => {
  const source = record(value, 'response');
  knownKeys(source, ['headline', 'reason', 'evidence', 'captureAdvice', 'actions', 'model'], 'response');
  const parsed: CoachResponse = {
    headline: conciseString(source.headline, 'response.headline', 8),
    reason: conciseString(source.reason, 'response.reason', 24),
    evidence: array(source.evidence, 'response.evidence', 4).map((entry, index) => coachEvidence(entry, `response.evidence[${index}]`)),
    captureAdvice: array(source.captureAdvice, 'response.captureAdvice', 3).map((entry, index) => captureAdvice(entry, `response.captureAdvice[${index}]`)),
    actions: array(source.actions, 'response.actions', 2).map((entry, index) => coachAction(entry, `response.actions[${index}]`)),
    model: string(source.model, 'response.model'),
  };
  if (parsed.actions.some((action) => action.tool === 'retake') && parsed.captureAdvice.length === 0) {
    invalid('response.captureAdvice', 'must accompany a retake action');
  }
  return parsed;
};
