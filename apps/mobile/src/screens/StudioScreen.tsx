import { randomUUID } from 'expo-crypto';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PhotoCanvas } from '../components/PhotoCanvas';
import { AdjustmentSheet, type AdjustmentSection } from '../components/studio/AdjustmentSheet';
import { LooksPanel } from '../components/studio/LooksPanel';
import { StudioToolRail, type StudioTool } from '../components/studio/StudioToolRail';
import { colors } from '../components/theme';
import { deleteGeneratedLayerAsset, deleteImportedLayerAsset, saveGeneratedLayerAsset, saveImportedLayerAsset } from '../data/photoRepository';
import { recordRecommendationFeedback } from '../data/preferences';
import { deleteStyleProfile, loadStyleProfiles, renameStyleProfile, saveStyleProfile, type SavedStyleProfile } from '../data/styleRepository';
import { centeredCrop, restoreManualTransform, rotateClockwise, withStraighten } from '../domain/canvasTransforms';
import {
  applyCoachFeedback,
  buildCoachFeedback,
  type CoachFeedbackItem,
  type CoachFeedbackPlan,
  type CoachFeedbackSection,
} from '../domain/coachFeedback';
import {
  analysisWithEditableMetadata,
  editableMetadataFrom,
  exifWithEditableMetadata,
  filledMetadataFieldCount,
  type EditablePhotoMetadata,
} from '../domain/photoMetadata';
import {
  buildCoachEditPreview,
  isCoachEditPreviewCurrent,
  isPreviewableCoachActionPlan,
  planCoachAction,
  type CoachEditPreview,
  type PreviewableCoachActionPlan,
} from '../domain/coachHarness';
import { appendLayer, collectiveAdjustmentValues, currentVersion, isTranslatableLayer, layerTranslation, mergeCollectiveAdjustments, removeLayer, reorderLayer, reusableStyleAdjustments, setCollectiveAdjustments, setLayerOpacity, setLayerTranslation, StalePhotoVersionError, toggleLayer, type TranslatableLayer } from '../domain/layers';
import type {
  AdjustmentValues,
  AnalysisResult,
  CanvasTransform,
  CoachAction,
  CoachResponse,
  GenerativeOperation,
  GenerativePatchLayer,
  ImageLayer,
  Issue,
  LayerTranslation,
  LayerStack,
  MetadataAdvice,
  Region,
  StyleLayer,
} from '../domain/types';

import { ApiUnavailableError, askCoach, createGenerativeLayers, getMetadataAdvice } from '../services/api';
import { exportAndShare } from '../services/export';
import { persistPreferences, persistStyleProfile, syncStyleProfileDeletions } from '../services/sync';
import { useExposure } from '../state/ExposureContext';
import { identityCanvasTransform } from '../domain/types';

const CENTER_TARGET: Region = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
const UPPER_TARGET: Region = { x: 0.2, y: 0.08, width: 0.6, height: 0.34 };
const LOWER_TARGET: Region = { x: 0.2, y: 0.58, width: 0.6, height: 0.34 };
const INITIAL_FREEFORM_CROP: Region = { x: 0.04, y: 0.04, width: 0.92, height: 0.92 };
type ExpansionDirection = 'top' | 'right' | 'bottom' | 'left';
type GenerativeDraft = {
  sourcePhotoId: string;
  sourceVersionId: string;
  label: string;
  stack: LayerStack;
  layers: GenerativePatchLayer[];
  recommendation?: Issue;
};
type CoachEditDraft = {
  sourcePhotoId: string;
  sourceVersionId: string;
  label: string;
  preview: CoachEditPreview;
  recommendation?: Issue;
};
type PreviewComparison = 'before' | 'after';
type ReusableLayerSource = {
  sourceAssetId: string;
  name: string;
  uri: string;
  mimeType: 'image/jpeg' | 'image/png';
};

const aspectLabel = (aspect: number) => {
  if (Math.abs(aspect - 1) < 0.001) return '1:1';
  if (Math.abs(aspect - 4 / 3) < 0.001) return '4:3';
  if (Math.abs(aspect - 3 / 4) < 0.001) return '3:4';
  if (Math.abs(aspect - 16 / 9) < 0.001) return '16:9';
  if (Math.abs(aspect - 9 / 16) < 0.001) return '9:16';
  return aspect.toFixed(2);
};

const layerNameFromFile = (name?: string | null) => {
  const withoutExtension = name?.replace(/\.(jpe?g|png|heic|heif)$/i, '').trim();
  return withoutExtension || 'Image layer';
};

const removeStyleLayers = (stack: LayerStack): LayerStack => ({
  ...stack,
  layers: stack.layers.filter((layer) => layer.type !== 'style'),
});

const applyStyleLayer = (
  stack: LayerStack,
  look: SavedStyleProfile,
  strength: number,
  layerId: string,
  createdAt: string,
): LayerStack => {
  const withoutStyle = removeStyleLayers(stack);
  return {
    ...withoutStyle,
    layers: [
      ...withoutStyle.layers,
      {
      id: layerId,
      type: 'style',
      name: look.name,
      enabled: true,
      opacity: 1,
      createdAt,
      styleProfileId: look.id,
      adjustments: look.adjustments,
      strength,
      },
    ],
  };
};

export const StudioScreen = ({ onClose, onRetake }: { onClose: () => void; onRetake: () => void }) => {
  const {
    ownerId,
    photos,
    selectedPhoto,
    analysis,
    analyzing,
    commitStack,
    updatePhotoExif,
    restore,
    runAnalysis,
  } = useExposure();
  const [tool, setTool] = useState<StudioTool>('coach');
  const [adjustmentSection, setAdjustmentSection] = useState<AdjustmentSection>('light');
  const [cropAspect, setCropAspect] = useState<number>();
  const [previewImageSize, setPreviewImageSize] = useState<{ uri: string; width: number; height: number }>();
  const [message, setMessage] = useState<string>();
  const [coachResponse, setCoachResponse] = useState<CoachResponse>();
  const [coachFeedback, setCoachFeedback] = useState<CoachFeedbackPlan>();
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [coachQuestion, setCoachQuestion] = useState('');
  const [coachBusy, setCoachBusy] = useState(false);
  const [metadataDraft, setMetadataDraft] = useState<EditablePhotoMetadata>(() => (
    editableMetadataFrom(selectedPhoto?.exif ?? {}, analysis)
  ));
  const [metadataAdvice, setMetadataAdvice] = useState<MetadataAdvice>();
  const [metadataAdviceBusy, setMetadataAdviceBusy] = useState(false);
  const metadataDraftRef = useRef(metadataDraft);
  metadataDraftRef.current = metadataDraft;
  const [selectedIssueId, setSelectedIssueId] = useState<string>();
  const [dismissedIssueIds, setDismissedIssueIds] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [draftAdjustments, setDraftAdjustments] = useState<AdjustmentValues>({});
  const [assetBusy, setAssetBusy] = useState(false);
  const [generativeOperation, setGenerativeOperation] = useState<GenerativeOperation>('amplify');
  const [generativePrompt, setGenerativePrompt] = useState('');
  const [generativeTarget, setGenerativeTarget] = useState<Region>(CENTER_TARGET);
  const [generativeRecommendationId, setGenerativeRecommendationId] = useState<string>();
  const [expansionDirection, setExpansionDirection] = useState<ExpansionDirection>('right');
  const [expansionFraction, setExpansionFraction] = useState(0.25);
  const [generativeDraft, setGenerativeDraft] = useState<GenerativeDraft>();
  const [generativePreviewLoadedLayerIds, setGenerativePreviewLoadedLayerIds] = useState<string[]>([]);
  const generativeDraftRef = useRef<GenerativeDraft | undefined>(undefined);
  const generativeCommitRef = useRef(false);
  const [coachEditDraft, setCoachEditDraft] = useState<CoachEditDraft>();
  const coachEditDraftRef = useRef<CoachEditDraft | undefined>(undefined);
  const coachEditCommitRef = useRef(false);
  const [coachPreviewComparison, setCoachPreviewComparison] = useState<PreviewComparison>('after');
  const mountedRef = useRef(true);
  const adjustmentCommitRef = useRef(false);
  const [savedLooks, setSavedLooks] = useState<SavedStyleProfile[]>([]);
  const [looksLoading, setLooksLoading] = useState(true);
  const [lookBusy, setLookBusy] = useState(false);
  const [selectedLookId, setSelectedLookId] = useState<string>();
  const [lookStrength, setLookStrength] = useState(0.75);
  const [lookDraftLayerId, setLookDraftLayerId] = useState(() => randomUUID());
  const lookCommitRef = useRef(false);
  const [renamingLookId, setRenamingLookId] = useState<string>();
  const [presetBusy, setPresetBusy] = useState(false);
  const [draftTransform, setDraftTransform] = useState<CanvasTransform>(() => identityCanvasTransform());
  const [draftLayerOpacities, setDraftLayerOpacities] = useState<Record<string, number>>({});
  const [draftLayerTranslations, setDraftLayerTranslations] = useState<Record<string, LayerTranslation>>({});
  const [selectedLayerId, setSelectedLayerId] = useState<string>();
  const [showLayerSources, setShowLayerSources] = useState(false);
  const [layerImporting, setLayerImporting] = useState(false);
  const [layerBusyId, setLayerBusyId] = useState<string>();
  const transformCommitRef = useRef(false);

  const version = selectedPhoto ? currentVersion(selectedPhoto) : undefined;
  const currentSelectionRef = useRef({ photoId: selectedPhoto?.id, versionId: version?.id });
  currentSelectionRef.current = { photoId: selectedPhoto?.id, versionId: version?.id };
  const savedAdjustments = useMemo(
    () => version ? collectiveAdjustmentValues(version.stack) : {},
    [version],
  );
  const appliedLookLayer = useMemo<StyleLayer | undefined>(
    () => version ? [...version.stack.layers].reverse().find((layer): layer is StyleLayer => layer.type === 'style') : undefined,
    [version],
  );
  const styleLayerCount = useMemo(
    () => version?.stack.layers.filter((layer) => layer.type === 'style').length ?? 0,
    [version],
  );
  const selectedLook = savedLooks.find((look) => look.id === selectedLookId);
  const visibleIssues = useMemo(
    () => analysis?.issues.filter((issue) => !dismissedIssueIds.includes(issue.id)) ?? [],
    [analysis?.issues, dismissedIssueIds],
  );
  const selectedIssue = visibleIssues.find((issue) => issue.id === selectedIssueId) ?? visibleIssues[0];
  const explicitRecommendation = generativeRecommendationId
    ? visibleIssues.find((issue) => issue.id === generativeRecommendationId)
    : undefined;
  const reusableLayerSources = useMemo<ReusableLayerSource[]>(() => {
    const seen = new Set<string>();
    const sources: ReusableLayerSource[] = [];
    for (const photo of photos) {
      for (const photoVersion of [...photo.versions].reverse()) {
        for (const layer of [...photoVersion.stack.layers].reverse()) {
          if (layer.type !== 'image' || !layer.uri.startsWith('file:')) continue;
          const sourceAssetId = layer.sourceAssetId ?? layer.assetId;
          if (seen.has(sourceAssetId)) continue;
          seen.add(sourceAssetId);
          sources.push({
            sourceAssetId,
            name: layer.name,
            uri: layer.uri,
            mimeType: /\.png(?:$|\?)/i.test(layer.uri) ? 'image/png' : 'image/jpeg',
          });
          if (sources.length === 12) return sources;
        }
      }
    }
    return sources;
  }, [photos]);

  const deleteDraftAssets = useCallback((draft: GenerativeDraft) => {
    for (const layer of draft.layers) {
      deleteGeneratedLayerAsset(layer.patchAssetId);
      deleteGeneratedLayerAsset(layer.maskAssetId);
    }
  }, []);

  const releaseGenerativeDraft = useCallback((deleteAssets: boolean) => {
    const draft = generativeDraftRef.current;
    if (draft && deleteAssets) deleteDraftAssets(draft);
    generativeDraftRef.current = undefined;
    if (mountedRef.current) {
      setGenerativeDraft(undefined);
      setGenerativePreviewLoadedLayerIds([]);
    }
  }, [deleteDraftAssets]);

  const releaseCoachEditDraft = useCallback(() => {
    coachEditDraftRef.current = undefined;
    if (mountedRef.current) {
      setCoachEditDraft(undefined);
      setCoachPreviewComparison('after');
    }
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    const draft = generativeDraftRef.current;
    if (draft && !generativeCommitRef.current) {
      deleteDraftAssets(draft);
      generativeDraftRef.current = undefined;
    }
  }, [deleteDraftAssets]);

  useEffect(() => {
    const draft = generativeDraftRef.current;
    if (!draft) return;
    if (generativeCommitRef.current) return;
    if (draft.sourcePhotoId === selectedPhoto?.id && draft.sourceVersionId === version?.id) return;
    releaseGenerativeDraft(true);
    setMessage('The photo changed, so the AI preview was discarded.');
  }, [releaseGenerativeDraft, selectedPhoto?.id, version?.id]);

  useEffect(() => {
    const draft = coachEditDraftRef.current;
    if (!draft || coachEditCommitRef.current) return;
    if (isCoachEditPreviewCurrent(draft, selectedPhoto?.id, version?.id)) return;
    releaseCoachEditDraft();
    setMessage('The photo changed, so the Coach preview was discarded.');
  }, [releaseCoachEditDraft, selectedPhoto?.id, version?.id]);

  useEffect(() => {
    let active = true;
    setLooksLoading(true);
    setRenamingLookId(undefined);
    loadStyleProfiles(ownerId)
      .then((looks) => { if (active) setSavedLooks(looks); })
      .catch(() => { if (active) setMessage('Saved Looks could not be loaded.'); })
      .finally(() => { if (active) setLooksLoading(false); });
    return () => { active = false; };
  }, [ownerId]);

  useEffect(() => {
    setDraftAdjustments(savedAdjustments);
  }, [savedAdjustments, version?.id]);

  useEffect(() => {
    setCoachResponse(undefined);
  }, [version?.id]);

  useEffect(() => {
    setMetadataDraft(editableMetadataFrom(selectedPhoto?.exif ?? {}));
    setCoachResponse(undefined);
    setCoachFeedback(undefined);
    setMetadataAdvice(undefined);
  }, [selectedPhoto?.id]);

  useEffect(() => {
    setSelectedLookId(appliedLookLayer?.styleProfileId);
    setLookStrength(appliedLookLayer?.strength ?? 0.75);
    setLookDraftLayerId(appliedLookLayer?.id ?? randomUUID());
  }, [appliedLookLayer?.id, appliedLookLayer?.strength, appliedLookLayer?.styleProfileId, version?.id]);

  const presetAdjustments = useMemo(
    () => version
      ? reusableStyleAdjustments(setCollectiveAdjustments(version.stack, draftAdjustments))
      : {},
    [draftAdjustments, version],
  );
  const canCreatePreset = Object.values(presetAdjustments)
    .some((value) => Math.abs(value ?? 0) > 0.0001);

  useEffect(() => {
    if (!version) return;
    setDraftTransform(version.stack.canvasTransform);
    setDraftLayerOpacities(Object.fromEntries(version.stack.layers.map((layer) => [layer.id, layer.opacity])));
    setDraftLayerTranslations(Object.fromEntries(version.stack.layers.map((layer) => [layer.id, layerTranslation(layer)])));
    setSelectedLayerId((current) => (
      current && version.stack.layers.some((layer) => layer.id === current)
        ? current
        : [...version.stack.layers].reverse().find(isTranslatableLayer)?.id
    ));
  }, [version?.id]);

  const previewStack = useMemo<LayerStack | undefined>(() => {
    if (!version) return undefined;
    if (
      tool === 'coach'
      && coachEditDraft
      && isCoachEditPreviewCurrent(coachEditDraft, selectedPhoto?.id, version.id)
    ) return coachPreviewComparison === 'after' ? coachEditDraft.preview.stack : version.stack;
    if (
      tool === 'ai'
      &&
      generativeDraft
      && generativeDraft.sourcePhotoId === selectedPhoto?.id
      && generativeDraft.sourceVersionId === version.id
    ) return generativeDraft.stack;
    const collectiveStack = tool === 'adjust'
      ? setCollectiveAdjustments(version.stack, draftAdjustments)
      : version.stack;
    const transformedStack: LayerStack = tool === 'adjust'
      ? { ...collectiveStack, canvasTransform: draftTransform }
      : collectiveStack;
    const adjustedStack: LayerStack = tool === 'layers'
      ? {
          ...transformedStack,
          layers: transformedStack.layers.map((layer) => ({
            ...layer,
            opacity: draftLayerOpacities[layer.id] ?? layer.opacity,
            translation: draftLayerTranslations[layer.id] ?? layer.translation,
          })),
        }
      : transformedStack;
    if (tool !== 'looks' || !selectedLook) return adjustedStack;
    return applyStyleLayer(
      adjustedStack,
      selectedLook,
      lookStrength,
      appliedLookLayer?.id ?? lookDraftLayerId,
      appliedLookLayer?.createdAt ?? new Date().toISOString(),
    );
  }, [appliedLookLayer?.createdAt, appliedLookLayer?.id, coachEditDraft, coachPreviewComparison, draftAdjustments, draftLayerOpacities, draftLayerTranslations, draftTransform, generativeDraft, lookDraftLayerId, lookStrength, selectedLook, selectedPhoto?.id, tool, version]);

  const updateGenerativeTarget = useCallback((target: Region) => {
    setGenerativeTarget(target);
    setSelectedIssueId(undefined);
    setGenerativeRecommendationId(undefined);
  }, []);

  const previewUri = selectedPhoto?.analysisProxyUri;
  const handlePreviewImageSizeChange = useCallback((size: { width: number; height: number }) => {
    if (!previewUri) return;
    setPreviewImageSize((current) => (
      current?.uri === previewUri && current.width === size.width && current.height === size.height
        ? current
        : { uri: previewUri, ...size }
    ));
  }, [previewUri]);

  if (!selectedPhoto || !version || !previewStack) {
    return (
      <SafeAreaView style={styles.empty}>
        <Text style={styles.emptyTitle}>No photo selected</Text>
        <Pressable accessibilityRole="button" style={styles.emptyButton} onPress={onClose}><Text style={styles.link}>Back to Library</Text></Pressable>
      </SafeAreaView>
    );
  }

  const commit = async (stack: LayerStack, label: string, expectedVersionId = version.id) => {
    setMessage(undefined);
    try {
      await commitStack(stack, label, expectedVersionId);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Edit failed.');
      return false;
    }
  };

  const mergeMissingMetadataFromAnalysis = (result: AnalysisResult) => {
    const detected = editableMetadataFrom(selectedPhoto.exif, result);
    const merged = { ...metadataDraftRef.current };
    for (const field of metadataFields) {
      if (!merged[field.key].trim() && detected[field.key].trim()) {
        merged[field.key] = detected[field.key];
      }
    }
    metadataDraftRef.current = merged;
    setMetadataDraft(merged);
    return merged;
  };

  const acceptRecommendation = async (issue?: Issue) => {
    if (!issue) return;
    const preferences = await recordRecommendationFeedback(issue.id, true);
    void persistPreferences(preferences).catch(() => undefined);
  };

  const dismissRecommendation = async (issue: Issue) => {
    const preferences = await recordRecommendationFeedback(issue.id, false);
    void persistPreferences(preferences).catch(() => undefined);
    setDismissedIssueIds((current) => [...new Set([...current, issue.id])]);
    setSelectedIssueId(undefined);
  };

  const openAmplifyTool = (target: Region, prompt: string, recommendationIssueId?: string) => {
    setGenerativeOperation('amplify');
    setGenerativeTarget(target);
    setGenerativePrompt(prompt);
    setSelectedIssueId(recommendationIssueId);
    setGenerativeRecommendationId(recommendationIssueId);
    setTool('ai');
  };

  const openCoachEditPreview = (
    label: string,
    plan: PreviewableCoachActionPlan,
    recommendation?: Issue,
  ) => {
    const draft: CoachEditDraft = {
      sourcePhotoId: selectedPhoto.id,
      sourceVersionId: version.id,
      label,
      preview: buildCoachEditPreview(version.stack, plan, {
        id: randomUUID(),
        name: label,
        createdAt: new Date().toISOString(),
      }),
      recommendation,
    };
    coachEditDraftRef.current = draft;
    setCoachEditDraft(draft);
    setCoachPreviewComparison('after');
  };

  const applyIssue = (issue: Issue) => {
    if (issue.fix?.kind === 'adjustment' && issue.fix.adjustments) {
      const adjusted = mergeCollectiveAdjustments(version.stack, issue.fix.adjustments);
      openCoachEditPreview(`Fix: ${issue.title}`, {
        kind: 'collective-adjustment',
        adjustments: collectiveAdjustmentValues(adjusted),
      }, issue);
    } else if (issue.fix?.kind === 'masked-adjustment' && issue.fix.adjustments) {
      openCoachEditPreview(`Fix: ${issue.title}`, {
        kind: 'masked-adjustment',
        adjustments: issue.fix.adjustments,
        target: issue.location,
      }, issue);
    } else if (issue.fix?.kind === 'transform' && issue.fix.canvasTransform) {
      openCoachEditPreview(`Fix: ${issue.title}`, {
        kind: 'canvas-transform',
        transform: {
          ...version.stack.canvasTransform,
          ...issue.fix.canvasTransform,
          rotationDegrees: version.stack.canvasTransform.rotationDegrees + (issue.fix.canvasTransform.rotationDegrees ?? 0),
        },
      }, issue);
    } else if (issue.fix?.kind === 'retouch' || issue.fix?.kind === 'generative') {
      openAmplifyTool(
        issue.location,
        issue.fix.kind === 'retouch'
          ? `Remove ${issue.title.toLowerCase()} and reconstruct the surrounding background.`
          : issue.recommendedAction,
        issue.id,
      );
    } else if (issue.fix?.kind === 'crop') {
      setAdjustmentSection('crop');
      setTool('adjust');
    } else if (issue.fix?.kind === 'retake') {
      onRetake();
    }
  };

  const analyze = async () => {
    if (analyzing || feedbackBusy || metadataAdviceBusy) return;
    setMessage(undefined);
    setFeedbackBusy(true);
    try {
      const result = await runAnalysis();
      mergeMissingMetadataFromAnalysis(result);
      setCoachFeedback(buildCoachFeedback(
        result,
        collectiveAdjustmentValues(version.stack),
        version.stack.canvasTransform,
      ));
      const firstIssue = result.issues[0];
      setDismissedIssueIds([]);
      setSelectedIssueId(firstIssue?.id);
      if (firstIssue) setGenerativeTarget(firstIssue.location);
    } catch (error) {
      setMessage(error instanceof ApiUnavailableError ? error.message : error instanceof Error ? error.message : 'Analysis failed.');
    } finally {
      setFeedbackBusy(false);
    }
  };

  const persistMetadataDraft = async () => {
    const exif = exifWithEditableMetadata(selectedPhoto.exif, metadataDraftRef.current);
    await updatePhotoExif(exif, selectedPhoto.id);
  };

  const saveMetadataDraft = async () => {
    try {
      await persistMetadataDraft();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Metadata could not be saved.');
    }
  };

  const requestMetadataAdvice = async () => {
    if (analyzing || feedbackBusy || metadataAdviceBusy || filledMetadataFieldCount(metadataDraftRef.current) <= 3) return;
    setMessage(undefined);
    setMetadataAdviceBusy(true);
    try {
      await persistMetadataDraft();
      const result = await runAnalysis();
      const metadata = mergeMissingMetadataFromAnalysis(result);
      await updatePhotoExif(exifWithEditableMetadata(selectedPhoto.exif, metadata), selectedPhoto.id);
      const groundedAnalysis = analysisWithEditableMetadata(result, metadata);
      setMetadataAdvice(await getMetadataAdvice(groundedAnalysis, metadata));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Hardware advice is unavailable.');
    } finally {
      setMetadataAdviceBusy(false);
    }
  };

  const ask = async () => {
    if (!analysis || !coachQuestion.trim()) return;
    setMessage(undefined);
    setCoachBusy(true);
    try {
      setCoachResponse(await askCoach(analysis, coachQuestion.trim(), { stack: version.stack, selectedIssueId: selectedIssue?.id }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Coach is unavailable.');
    } finally {
      setCoachBusy(false);
    }
  };

  const applyCoachAction = (action: CoachAction) => {
    if (!action.requiresConfirmation) return;
    setMessage(undefined);
    try {
      const plan = planCoachAction(action, version.stack.canvasTransform);
      if (isPreviewableCoachActionPlan(plan)) {
        openCoachEditPreview(action.label, plan, selectedIssue);
      } else if (plan.kind === 'generative') {
        openAmplifyTool(plan.target, plan.prompt, selectedIssue?.id);
      } else if (plan.kind === 'expand') {
        setExpansionDirection(plan.direction);
        setExpansionFraction(plan.fraction);
        setGenerativeOperation('expand');
        setGenerativePrompt(plan.prompt);
        setGenerativeRecommendationId(selectedIssue?.id);
        setTool('ai');
      } else {
        onRetake();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Coach action could not be prepared.');
    }
  };

  const acceptCoachEditDraft = async () => {
    const draft = coachEditDraftRef.current;
    if (!draft || coachEditCommitRef.current) return;
    coachEditCommitRef.current = true;
    setMessage(undefined);
    setApplying(true);
    try {
      if (!isCoachEditPreviewCurrent(
        draft,
        currentSelectionRef.current.photoId,
        currentSelectionRef.current.versionId,
      )) throw new StalePhotoVersionError();
      await commitStack(draft.preview.stack, draft.label, draft.sourceVersionId);
      releaseCoachEditDraft();
      void acceptRecommendation(draft.recommendation).catch(() => undefined);
      if (draft.preview.kind === 'masked-adjustment') {
        setTool('layers');
      } else {
        if (draft.preview.kind === 'canvas-transform') setAdjustmentSection('crop');
        setTool('adjust');
      }
    } catch (error) {
      if (
        error instanceof StalePhotoVersionError
        || !mountedRef.current
        || !isCoachEditPreviewCurrent(
          draft,
          currentSelectionRef.current.photoId,
          currentSelectionRef.current.versionId,
        )
      ) releaseCoachEditDraft();
      if (mountedRef.current) setMessage(error instanceof Error ? error.message : 'Coach edit failed.');
    } finally {
      coachEditCommitRef.current = false;
      if (mountedRef.current) setApplying(false);
    }
  };

  const acceptAllCoachFeedback = async () => {
    if (!coachFeedback || applying) return;
    setApplying(true);
    setMessage(undefined);
    try {
      const next = applyCoachFeedback(version.stack, coachFeedback);
      const changed = await commit(next, 'Coach: Apply all feedback', version.id);
      if (!changed) return;
      setDraftAdjustments(coachFeedback.adjustments);
      setDraftTransform(next.canvasTransform);
      setCropAspect(undefined);
      setAdjustmentSection('light');
      setTool('adjust');
      setMessage('Coach adjustments applied.');
    } finally {
      setApplying(false);
    }
  };

  const commitAdjustment = async (key: keyof AdjustmentValues, value: number) => {
    if (adjustmentCommitRef.current) return;
    adjustmentCommitRef.current = true;
    const next = { ...draftAdjustments, [key]: value };
    setDraftAdjustments(next);
    setApplying(true);
    try {
      const changed = await commit(setCollectiveAdjustments(version.stack, next), `Adjust ${String(key).replace('-', ' ')}`);
      if (!changed) setDraftAdjustments(savedAdjustments);
    } finally {
      adjustmentCommitRef.current = false;
      setApplying(false);
    }
  };

  const restoreAdjustments = async () => {
    if (adjustmentCommitRef.current) return;
    adjustmentCommitRef.current = true;
    setDraftAdjustments({});
    setApplying(true);
    try {
      const changed = await commit(setCollectiveAdjustments(version.stack, {}), 'Reset adjustments');
      if (!changed) setDraftAdjustments(savedAdjustments);
    } finally {
      adjustmentCommitRef.current = false;
      setApplying(false);
    }
  };

  const commitTransform = async (next: CanvasTransform, label: string) => {
    if (transformCommitRef.current) return;
    if (JSON.stringify(next) === JSON.stringify(version.stack.canvasTransform)) {
      setDraftTransform(version.stack.canvasTransform);
      return;
    }
    transformCommitRef.current = true;
    setDraftTransform(next);
    setApplying(true);
    try {
      const changed = await commit({ ...version.stack, canvasTransform: next }, label);
      if (!changed) setDraftTransform(version.stack.canvasTransform);
    } finally {
      transformCommitRef.current = false;
      setApplying(false);
    }
  };

  const cropPhoto = (aspect: number | undefined) => {
    const next: CanvasTransform = { ...draftTransform };
    const decodedSize = previewImageSize?.uri === selectedPhoto.analysisProxyUri
      ? previewImageSize
      : undefined;
    const imageWidth = decodedSize?.width ?? selectedPhoto.width;
    const imageHeight = decodedSize?.height ?? selectedPhoto.height;
    setCropAspect(aspect);
    if (aspect === undefined) delete next.crop;
    else next.crop = centeredCrop(imageWidth, imageHeight, aspect, draftTransform.rotationDegrees);
    void commitTransform(next, aspect === undefined ? 'Original crop' : `Crop ${aspectLabel(aspect)}`);
  };

  const startFreeformCrop = () => {
    setCropAspect(undefined);
    setDraftTransform((current) => current.crop
      ? current
      : { ...current, crop: INITIAL_FREEFORM_CROP });
  };

  const commitLayerOpacity = async (layerId: string, value: number) => {
    if (layerBusyId) return;
    const layer = version.stack.layers.find((candidate) => candidate.id === layerId);
    if (!layer) return;
    if (Math.abs(layer.opacity - value) < 0.001) {
      setDraftLayerOpacities((current) => ({ ...current, [layerId]: layer.opacity }));
      return;
    }
    setDraftLayerOpacities((current) => ({ ...current, [layerId]: value }));
    setLayerBusyId(layerId);
    try {
      const changed = await commit(setLayerOpacity(version.stack, layerId, value), `Opacity: ${layer.name}`);
      if (!changed) setDraftLayerOpacities((current) => ({ ...current, [layerId]: layer.opacity }));
    } finally {
      setLayerBusyId(undefined);
    }
  };

  const commitLayerTranslation = async (layerId: string, translation: LayerTranslation) => {
    if (layerBusyId) return;
    const layer = version.stack.layers.find((candidate) => candidate.id === layerId);
    if (!layer || !isTranslatableLayer(layer)) return;
    const saved = layerTranslation(layer);
    if (Math.abs(saved.x - translation.x) < 0.0001 && Math.abs(saved.y - translation.y) < 0.0001) {
      setDraftLayerTranslations((current) => ({ ...current, [layerId]: saved }));
      return;
    }
    setDraftLayerTranslations((current) => ({ ...current, [layerId]: translation }));
    setLayerBusyId(layerId);
    try {
      const changed = await commit(
        setLayerTranslation(version.stack, layerId, translation),
        `Move ${layer.name}`,
      );
      if (!changed) setDraftLayerTranslations((current) => ({ ...current, [layerId]: saved }));
    } finally {
      setLayerBusyId(undefined);
    }
  };

  const addImageLayerFromSource = async (source: { uri: string; name?: string | null; mimeType?: string; sourceAssetId?: string }) => {
    const layerId = randomUUID();
    const assetId = randomUUID();
    let savedUri: string | undefined;
    try {
      savedUri = await saveImportedLayerAsset(assetId, source.uri, source.mimeType);
      const name = layerNameFromFile(source.name);
      const layer: ImageLayer = {
        id: layerId,
        type: 'image',
        name,
        enabled: true,
        opacity: 1,
        translation: { x: 0, y: 0 },
        createdAt: new Date().toISOString(),
        assetId,
        sourceAssetId: source.sourceAssetId ?? assetId,
        uri: savedUri,
        transform: identityCanvasTransform(),
        blendMode: 'normal',
      };
      const changed = await commit(appendLayer(version.stack, layer), `Add ${name}`);
      if (!changed) {
        deleteImportedLayerAsset(savedUri);
        return;
      }
      setSelectedLayerId(layerId);
      setShowLayerSources(false);
      setMessage(`${name} added. Drag on the canvas to position it.`);
    } catch (error) {
      if (savedUri) deleteImportedLayerAsset(savedUri);
      setMessage(error instanceof Error ? error.message : 'The image layer could not be added.');
    }
  };

  const runLayerImport = async (
    pick: () => Promise<{ uri: string; name?: string | null; mimeType?: string; sourceAssetId?: string } | undefined>,
  ) => {
    if (layerImporting) return;
    setLayerImporting(true);
    setMessage(undefined);
    try {
      const source = await pick();
      if (source) await addImageLayerFromSource(source);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The image layer could not be opened.');
    } finally {
      setLayerImporting(false);
    }
  };

  const importLayerFromPhotos = () => void runLayerImport(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled) return undefined;
    const asset = result.assets[0];
    return { uri: asset.uri, name: asset.fileName, mimeType: asset.mimeType };
  });

  const importLayerFromFiles = () => void runLayerImport(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['image/jpeg', 'image/png', 'image/heic', 'image/heif'],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return undefined;
    const asset = result.assets[0];
    return { uri: asset.uri, name: asset.name, mimeType: asset.mimeType };
  });

  const chooseLook = async (look: SavedStyleProfile) => {
    if (lookCommitRef.current) return;
    const sameLook = appliedLookLayer?.styleProfileId === look.id;
    const nextStrength = sameLook ? appliedLookLayer.strength : 0.75;
    const nextLayerId = appliedLookLayer?.id ?? randomUUID();
    setSelectedLookId(look.id);
    setLookStrength(nextStrength);
    setLookDraftLayerId(nextLayerId);
    if (sameLook && styleLayerCount === 1) return;
    lookCommitRef.current = true;
    setLookBusy(true);
    try {
      const changed = await commit(
        applyStyleLayer(
          version.stack,
          look,
          nextStrength,
          nextLayerId,
          appliedLookLayer?.createdAt ?? new Date().toISOString(),
        ),
        `Look: ${look.name}`,
        version.id,
      );
      if (!changed) {
        setSelectedLookId(appliedLookLayer?.styleProfileId);
        setLookStrength(appliedLookLayer?.strength ?? 0.75);
        setLookDraftLayerId(appliedLookLayer?.id ?? randomUUID());
      }
    } finally {
      lookCommitRef.current = false;
      setLookBusy(false);
    }
  };

  const commitLookStrength = async (strength: number) => {
    setLookStrength(strength);
    if (!selectedLook || lookCommitRef.current) return;
    if (
      styleLayerCount === 1
      && appliedLookLayer?.styleProfileId === selectedLook.id
      && Math.abs(appliedLookLayer.strength - strength) <= 0.001
    ) return;
    lookCommitRef.current = true;
    setLookBusy(true);
    try {
      const changed = await commit(
        applyStyleLayer(
          version.stack,
          selectedLook,
          strength,
          appliedLookLayer?.id ?? lookDraftLayerId,
          appliedLookLayer?.createdAt ?? new Date().toISOString(),
        ),
        `Look strength: ${selectedLook.name}`,
        version.id,
      );
      if (!changed) setLookStrength(appliedLookLayer?.strength ?? 0.75);
    } finally {
      lookCommitRef.current = false;
      setLookBusy(false);
    }
  };

  const restoreLook = async () => {
    if (lookCommitRef.current) return;
    if (!appliedLookLayer) {
      setSelectedLookId(undefined);
      setLookStrength(0.75);
      setLookDraftLayerId(randomUUID());
      return;
    }
    lookCommitRef.current = true;
    setLookBusy(true);
    try {
      const changed = await commit(removeStyleLayers(version.stack), 'Original look');
      if (changed) {
        setSelectedLookId(undefined);
        setLookStrength(0.75);
        setLookDraftLayerId(randomUUID());
      }
    } finally {
      lookCommitRef.current = false;
      setLookBusy(false);
    }
  };

  const createPreset = async () => {
    if (presetBusy || !canCreatePreset) return;
    setPresetBusy(true);
    setMessage(undefined);
    try {
      const customPresetCount = savedLooks.filter((look) => !look.isBuiltIn).length;
      const created = await saveStyleProfile({
        id: randomUUID(),
        name: `Preset ${customPresetCount + 1}`,
        adjustments: presetAdjustments,
        palette: [],
        mood: 'Created from your current edits',
      }, []);
      setSavedLooks((current) => [
        ...current.filter((look) => look.isBuiltIn),
        created,
        ...current.filter((look) => !look.isBuiltIn && look.id !== created.id),
      ]);
      setRenamingLookId(created.id);
      setTool('looks');
      setMessage('Preset saved. Give it a name.');
      void persistStyleProfile(created, []).catch(() => {
        if (mountedRef.current) setMessage('Preset saved on this device, but it could not sync yet.');
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Preset could not be saved.');
    } finally {
      setPresetBusy(false);
    }
  };

  const renamePreset = async (lookId: string, name: string) => {
    if (presetBusy) return;
    setPresetBusy(true);
    setMessage(undefined);
    try {
      const updated = await renameStyleProfile(lookId, name, ownerId);
      setSavedLooks((current) => current.map((look) => look.id === updated.id ? updated : look));
      setRenamingLookId(undefined);
      setMessage(`Preset renamed to ${updated.name}.`);
      void persistStyleProfile(updated, updated.referencePhotoIds).catch(() => {
        if (mountedRef.current) setMessage(`${updated.name} was renamed on this device, but it could not sync yet.`);
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Preset could not be renamed.');
    } finally {
      setPresetBusy(false);
    }
  };

  const deletePreset = async (look: SavedStyleProfile) => {
    if (look.isBuiltIn || presetBusy) return;
    setPresetBusy(true);
    setMessage(undefined);
    const keepsCurrentEdits = appliedLookLayer?.styleProfileId === look.id;
    try {
      if (keepsCurrentEdits) {
        const flattenedAdjustments = reusableStyleAdjustments(version.stack);
        const changed = await commit(
          setCollectiveAdjustments(removeStyleLayers(version.stack), flattenedAdjustments),
          `Keep edits after deleting ${look.name}`,
          version.id,
        );
        if (!changed) return;
      }
      await deleteStyleProfile(look.id, ownerId);
      setSavedLooks((current) => current.filter((item) => item.id !== look.id));
      setRenamingLookId((current) => current === look.id ? undefined : current);
      if (selectedLookId === look.id) {
        setSelectedLookId(undefined);
        setLookStrength(0.75);
        setLookDraftLayerId(randomUUID());
      }
      setMessage(keepsCurrentEdits
        ? `${look.name} was deleted. Its edits remain on this photo.`
        : `${look.name} was deleted.`);
      void syncStyleProfileDeletions(ownerId, [look.id]).catch(() => {
        if (mountedRef.current) setMessage(`${look.name} was deleted on this device and will be removed from the cloud when sync resumes.`);
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Preset could not be deleted.');
    } finally {
      setPresetBusy(false);
    }
  };

  const confirmDeletePreset = (look: SavedStyleProfile) => {
    if (look.isBuiltIn || presetBusy) return;
    Alert.alert(
      `Delete ${look.name}?`,
      'Photos already edited with this preset will keep their appearance.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void deletePreset(look) },
      ],
    );
  };

  const exportPhoto = async () => {
    setMessage(undefined);
    setExporting(true);
    try {
      await exportAndShare(selectedPhoto, previewStack);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const generateEdit = async () => {
    if (!generativePrompt.trim()) return;
    if (generativeDraftRef.current) releaseGenerativeDraft(true);
    setGenerativePreviewLoadedLayerIds([]);
    const sourceVersionId = version.id;
    const sourcePhotoId = selectedPhoto.id;
    setMessage(undefined);
    setAssetBusy(true);
    const savedAssetIds: string[] = [];
    try {
      const result = await createGenerativeLayers(
        selectedPhoto,
        version.stack,
        generativeTarget,
        generativePrompt.trim(),
        generativeOperation,
        expansionDirection,
        expansionFraction,
      );
      if (!result.layers.length) throw new Error('The generation returned no editable layers.');
      if (result.layers.some((layer) => layer.sourceVersionId !== sourceVersionId)) {
        throw new StalePhotoVersionError();
      }
      if (!mountedRef.current) return;
      if (
        currentSelectionRef.current.photoId !== sourcePhotoId
        || currentSelectionRef.current.versionId !== sourceVersionId
      ) throw new StalePhotoVersionError();
      const generatedLayers = result.layers.map((generated): GenerativePatchLayer => {
        const patchAssetId = randomUUID();
        const maskAssetId = randomUUID();
        savedAssetIds.push(patchAssetId, maskAssetId);
        const patchUri = saveGeneratedLayerAsset(patchAssetId, generated.patchBase64);
        const maskUri = saveGeneratedLayerAsset(maskAssetId, generated.maskBase64);
        return {
          id: randomUUID(), type: 'generative-patch', name: generated.name, enabled: true, opacity: 1,
          createdAt: new Date().toISOString(), patchAssetId, patchUri, maskAssetId, maskUri,
          target: generated.target, prompt: generated.prompt,
          canvasSpace: true,
          canvasExpansion: result.expansion ?? version.stack.canvasTransform.expansion ?? { top: 0, right: 0, bottom: 0, left: 0 },
          provenance: { model: generated.model, sourceVersionId: generated.sourceVersionId, driftScore: generated.driftScore },
        };
      });
      const label = generativeOperation === 'expand'
        ? `Expanded ${expansionDirection}`
        : generatedLayers.length === 1
          ? `Amplified ${generatedLayers[0].name}`
          : `Amplified ${generatedLayers.length} layers`;
      let candidateStack: LayerStack;
      if (generativeOperation === 'expand') {
        if (!result.expansion) throw new Error('The expansion result did not include canvas geometry.');
        candidateStack = {
          ...version.stack,
          canvasTransform: { ...version.stack.canvasTransform, expansion: result.expansion },
          layers: [...version.stack.layers, ...generatedLayers],
        };
      } else {
        candidateStack = { ...version.stack, layers: [...version.stack.layers, ...generatedLayers] };
      }
      const draft: GenerativeDraft = {
        sourcePhotoId,
        sourceVersionId,
        label,
        stack: candidateStack,
        layers: generatedLayers,
        recommendation: explicitRecommendation,
      };
      generativeDraftRef.current = draft;
      setGenerativeDraft(draft);
      savedAssetIds.length = 0;
    } catch (error) {
      for (const assetId of savedAssetIds) deleteGeneratedLayerAsset(assetId);
      if (mountedRef.current) setMessage(error instanceof Error ? error.message : 'AI edit failed.');
    } finally {
      if (mountedRef.current) setAssetBusy(false);
    }
  };

  const acceptGenerativeDraft = async () => {
    const draft = generativeDraftRef.current;
    if (!draft) return;
    if (!draft.layers.every((layer) => generativePreviewLoadedLayerIds.includes(layer.id))) {
      setMessage('The generated layers are still loading. Wait for the preview before accepting them.');
      return;
    }
    setMessage(undefined);
    setAssetBusy(true);
    generativeCommitRef.current = true;
    try {
      if (
        currentSelectionRef.current.photoId !== draft.sourcePhotoId
        || currentSelectionRef.current.versionId !== draft.sourceVersionId
      ) throw new StalePhotoVersionError();
      await commitStack(draft.stack, draft.label, draft.sourceVersionId);
      releaseGenerativeDraft(false);
      setTool('layers');
      await acceptRecommendation(draft.recommendation);
    } catch (error) {
      if (error instanceof StalePhotoVersionError || !mountedRef.current) releaseGenerativeDraft(true);
      if (mountedRef.current) setMessage(error instanceof Error ? error.message : 'AI edit failed.');
    } finally {
      generativeCommitRef.current = false;
      if (mountedRef.current) setAssetBusy(false);
    }
  };

  const handleGenerativeLayerReady = useCallback((layerId: string) => {
    const draft = generativeDraftRef.current;
    if (!draft || !draft.layers.some((layer) => layer.id === layerId)) return;
    console.info('[generative-preview] decoded image layer');
    setGenerativePreviewLoadedLayerIds((current) => {
      const next = [...new Set([...current, layerId])];
      if (draft.layers.every((layer) => next.includes(layer.id))) {
        setMessage(`${draft.layers.length} generated ${draft.layers.length === 1 ? 'layer is' : 'layers are'} ready to review.`);
      }
      return next;
    });
  }, []);

  const handleGenerativeLayerError = useCallback((layerId: string, error: Error) => {
    const draft = generativeDraftRef.current;
    if (!draft || !draft.layers.some((layer) => layer.id === layerId)) return;
    console.error('[generative-preview] image layer decode failed', error.message);
    releaseGenerativeDraft(true);
    setMessage('The generated PNG could not be decoded on this device, so the preview was discarded.');
  }, [releaseGenerativeDraft]);

  const selectIssue = (issue: Issue) => {
    setSelectedIssueId(issue.id);
    setGenerativeTarget(issue.location);
  };

  const generativePreviewReady = Boolean(
    generativeDraft
    && generativeDraft.layers.every((layer) => generativePreviewLoadedLayerIds.includes(layer.id)),
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close editor" style={styles.headerButton} onPress={onClose}>
          <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Edit</Text>
        </View>
        <Pressable accessibilityRole="button" style={styles.exportButton} onPress={exportPhoto} disabled={exporting}>
          {exporting ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Text style={styles.exportButtonText}>Export</Text>}
        </Pressable>
      </View>

      <View style={styles.canvas}>
        <PhotoCanvas
          uri={selectedPhoto.analysisProxyUri}
          stack={previewStack}
          analysis={analysis}
          target={tool === 'ai' && generativeOperation === 'amplify' ? generativeTarget : undefined}
          onTargetChange={tool === 'ai' && generativeOperation === 'amplify' ? updateGenerativeTarget : undefined}
          showIssues={tool === 'coach' && !coachEditDraft} // may be a regression, if so, put false
          editingCrop={tool === 'adjust' && adjustmentSection === 'crop'}
          cropRegion={draftTransform.crop}
          cropAspect={cropAspect}
          onCropChange={(crop) => setDraftTransform((current) => ({ ...current, crop }))}
          onCropCommit={(crop) => void commitTransform({ ...draftTransform, crop }, 'Crop')}
          onImageSizeChange={handlePreviewImageSizeChange}
          onGeneratedLayerReady={handleGenerativeLayerReady}
          onGeneratedLayerError={handleGenerativeLayerError}
          movableLayerId={tool === 'layers' ? selectedLayerId : undefined}
          onLayerTranslationChange={tool === 'layers' ? (layerId, translation, shouldCommit) => {
            setDraftLayerTranslations((current) => ({ ...current, [layerId]: translation }));
            if (shouldCommit) void commitLayerTranslation(layerId, translation);
          } : undefined}
        />
      </View>

      <View style={styles.panel}>
        {message ? <Text accessibilityRole="alert" numberOfLines={3} style={styles.message}>{message}</Text> : null}
        <ScrollView
          key={tool}
          contentContainerStyle={styles.panelContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {tool === 'coach' ? (
            coachEditDraft ? (
              <CoachEditPreviewPanel
                label={coachEditDraft.label}
                comparison={coachPreviewComparison}
                busy={applying}
                onComparisonChange={setCoachPreviewComparison}
                onDiscard={releaseCoachEditDraft}
                onAccept={() => void acceptCoachEditDraft()}
              />
            ) : (
              <CoachPanel
                analysisBusy={analyzing}
                applying={applying}
                feedbackBusy={feedbackBusy}
                feedback={coachFeedback}
                metadata={metadataDraft}
                metadataAdvice={metadataAdvice}
                metadataAdviceBusy={metadataAdviceBusy}
                onAnalyze={analyze}
                onAccept={() => void acceptAllCoachFeedback()}
                onMetadataAdvice={() => void requestMetadataAdvice()}
                onMetadataChange={(key, value) => {
                  setMetadataDraft((current) => ({ ...current, [key]: value }));
                }}
                onMetadataCommit={() => void saveMetadataDraft()}
                onOpenSection={(section) => {
                  setAdjustmentSection(section);
                  setTool('adjust');
                }}
              />
            )
          ) : null}

          {tool === 'adjust' ? (
            <AdjustmentSheet
              values={draftAdjustments}
              onChange={(key, value) => setDraftAdjustments((current) => ({ ...current, [key]: value }))}
              onCommit={commitAdjustment}
              onResetControl={(key) => void commitAdjustment(key, 0)}
              onRestore={() => void restoreAdjustments()}
              onCreatePreset={() => void createPreset()}
              canCreatePreset={canCreatePreset}
              presetBusy={presetBusy}
              busy={applying}
              section={adjustmentSection}
              onSectionChange={setAdjustmentSection}
              transform={draftTransform}
              imageWidth={previewImageSize?.uri === selectedPhoto.analysisProxyUri ? previewImageSize.width : selectedPhoto.width}
              imageHeight={previewImageSize?.uri === selectedPhoto.analysisProxyUri ? previewImageSize.height : selectedPhoto.height}
              onAngleChange={(degrees) => setDraftTransform((current) => withStraighten(current, degrees))}
              onAngleCommit={(degrees) => void commitTransform(withStraighten(draftTransform, degrees), 'Rotate angle')}
              onCrop={cropPhoto}
              onFreeformCrop={startFreeformCrop}
              lockedCropAspect={cropAspect}
              onRotate={() => {
                setCropAspect((current) => current ? 1 / current : undefined);
                void commitTransform(rotateClockwise(draftTransform), 'Rotate 90°');
              }}
              onRestoreTransform={() => {
                setCropAspect(undefined);
                void commitTransform(restoreManualTransform(draftTransform), 'Reset crop and rotation');
              }}
            />
          ) : null}

          {tool === 'looks' ? (
            <LooksPanel
              looks={savedLooks}
              selectedLookId={selectedLookId}
              strength={lookStrength}
              loading={looksLoading}
              busy={lookBusy}
              renamingLookId={renamingLookId}
              renameBusy={presetBusy}
              onSelect={(look) => void chooseLook(look)}
              onStrengthChange={setLookStrength}
              onStrengthCommit={(strength) => void commitLookStrength(strength)}
              onRestore={() => void restoreLook()}
              onStartRename={setRenamingLookId}
              onRename={(lookId, name) => void renamePreset(lookId, name)}
              onCancelRename={() => setRenamingLookId(undefined)}
              onDelete={confirmDeletePreset}
            />
          ) : null}

          {tool === 'ai' ? (
            <AiPanel
              operation={generativeOperation}
              prompt={generativePrompt}
              target={generativeTarget}
              issues={analysis?.issues ?? []}
              busy={assetBusy}
              expansionDirection={expansionDirection}
              expansionFraction={expansionFraction}
              previewLoading={Boolean(generativeDraft && !generativePreviewReady)}
              previewReady={generativePreviewReady}
              previewLayerCount={generativeDraft?.layers.length ?? 0}
              loadedLayerCount={generativePreviewLoadedLayerIds.length}
              onOperationChange={(operation) => {
                setGenerativeOperation(operation);
                setGenerativeRecommendationId(undefined);
                setGenerativePrompt(operation === 'expand'
                  ? 'Extend the scene naturally into the new canvas.'
                  : '');
              }}
              onPromptChange={setGenerativePrompt}
              onTargetChange={(target, issueId) => {
                setGenerativeTarget(target);
                setSelectedIssueId(issueId);
                setGenerativeRecommendationId(issueId);
              }}
              onGenerate={generateEdit}
              onAccept={() => void acceptGenerativeDraft()}
              onDiscard={() => releaseGenerativeDraft(true)}
              onExpansionDirectionChange={setExpansionDirection}
              onExpansionFractionChange={setExpansionFraction}
            />
          ) : null}

          {tool === 'more' ? <MorePanel onSelect={setTool} /> : null}

          {tool === 'layers' ? (
            <LayersPanel
              stack={version.stack}
              opacities={draftLayerOpacities}
              translations={draftLayerTranslations}
              selectedLayerId={selectedLayerId}
              reusableSources={reusableLayerSources}
              showSources={showLayerSources}
              importing={layerImporting}
              busyLayerId={layerBusyId}
              onSelectLayer={setSelectedLayerId}
              onToggleSources={() => setShowLayerSources((current) => !current)}
              onImportPhotos={importLayerFromPhotos}
              onImportFiles={importLayerFromFiles}
              onReuseSource={(source) => void runLayerImport(async () => source)}
              onOpacityChange={(layerId, opacity) => setDraftLayerOpacities((current) => ({ ...current, [layerId]: opacity }))}
              onOpacityCommit={(layerId, opacity) => void commitLayerOpacity(layerId, opacity)}
              onTranslationChange={(layerId, translation) => setDraftLayerTranslations((current) => ({ ...current, [layerId]: translation }))}
              onTranslationCommit={(layerId, translation) => void commitLayerTranslation(layerId, translation)}
              onCommit={commit}
            />
          ) : null}

          {tool === 'history' ? (
            <HistoryPanel photo={selectedPhoto} onRestore={restore} />
          ) : null}
        </ScrollView>
        <StudioToolRail
          active={tool}
          onChange={(nextTool) => {
            if (coachEditCommitRef.current) return;
            if (tool === 'adjust' && nextTool !== 'adjust') {
              setDraftAdjustments(savedAdjustments);
              setDraftTransform(version.stack.canvasTransform);
            }
            if (coachEditDraft && nextTool !== 'coach') releaseCoachEditDraft();
            if (generativeDraft && nextTool !== 'ai') releaseGenerativeDraft(true);
            if (tool === 'layers' && nextTool !== 'layers') {
              setDraftLayerOpacities(Object.fromEntries(version.stack.layers.map((layer) => [layer.id, layer.opacity])));
              setDraftLayerTranslations(Object.fromEntries(version.stack.layers.map((layer) => [layer.id, layerTranslation(layer)])));
              setShowLayerSources(false);
            }
            if (nextTool === 'ai') setGenerativeRecommendationId(undefined);
            setTool(nextTool);
          }}
        />
      </View>
    </SafeAreaView>
  );
};

const CoachEditPreviewPanel = ({
  label,
  comparison,
  busy,
  onComparisonChange,
  onDiscard,
  onAccept,
}: {
  label: string;
  comparison: PreviewComparison;
  busy: boolean;
  onComparisonChange: (comparison: PreviewComparison) => void;
  onDiscard: () => void;
  onAccept: () => void;
}) => (
  <View accessibilityLabel={`${label} preview`}>
    <Text numberOfLines={2} style={styles.previewTitle}>{label}</Text>
    <View accessibilityRole="tablist" style={styles.segmented}>
      {(['before', 'after'] as PreviewComparison[]).map((option) => {
        const selected = comparison === option;
        return (
          <Pressable
            key={option}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled: busy }}
            disabled={busy}
            onPress={() => onComparisonChange(option)}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.segmentActive,
              pressed && (selected ? styles.primaryPressed : styles.controlPressed),
            ]}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
              {option === 'before' ? 'Before' : 'After'}
            </Text>
          </Pressable>
        );
      })}
    </View>
    <View style={styles.previewActions}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        style={({ pressed }) => [styles.previewDiscard, pressed && styles.controlPressed, busy && styles.disabled]}
        onPress={onDiscard}
      >
        <Text style={styles.previewDiscardText}>Discard</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        style={({ pressed }) => [styles.previewAccept, pressed && styles.primaryPressed, busy && styles.disabled]}
        onPress={onAccept}
      >
        {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.previewAcceptText}>Accept</Text>}
      </Pressable>
    </View>
  </View>
);

type CoachPanelSection = 'feedback' | 'meta';

const coachPanelSections: Array<{ id: CoachPanelSection; label: string }> = [
  { id: 'feedback', label: 'Feedback' },
  { id: 'meta', label: 'Meta' },
];

const coachControlLabels: Record<keyof AdjustmentValues, string> = {
  exposure: 'Exposure',
  contrast: 'Contrast',
  highlights: 'Highlights',
  shadows: 'Shadows',
  temperature: 'Temperature',
  tint: 'Tint',
  saturation: 'Saturation',
  vibrance: 'Vibrance',
  sharpening: 'Sharpen',
  denoise: 'Denoise',
  grain: 'Grain',
  vignette: 'Vignette',
};

const formatCoachTarget = (key: keyof AdjustmentValues, value: number) => {
  const rounded = Math.round(value * 100);
  if (key === 'exposure') return `${value >= 0 ? '+' : ''}${value.toFixed(2)} EV`;
  return `${rounded > 0 ? '+' : ''}${rounded}`;
};

const CoachFeedbackCard = ({
  item,
  onOpenSection,
}: {
  item: CoachFeedbackItem;
  onOpenSection: (section: CoachFeedbackSection) => void;
}) => {
  const targets = Object.entries(item.adjustments ?? {}) as Array<[keyof AdjustmentValues, number]>;
  const icon = item.section === 'light'
    ? 'white-balance-sunny'
    : item.section === 'color'
      ? 'palette-outline'
      : item.section === 'detail'
        ? 'image-filter-center-focus'
        : 'crop';
  return (
    <View accessibilityLabel={`${item.section} feedback`} style={styles.coachFeedbackCard}>
      <View style={styles.coachFeedbackHeader}>
        <View style={styles.coachFeedbackSectionTitle}>
          <MaterialCommunityIcons color={colors.textSecondary} name={icon} size={18} />
          <Text style={styles.coachFeedbackSectionLabel}>{item.section.toUpperCase()}</Text>
        </View>
        <View style={[styles.coachFeedbackStatus, !item.changed && styles.coachFeedbackStatusIdle]}>
          <Text style={[styles.coachFeedbackStatusText, !item.changed && styles.coachFeedbackStatusTextIdle]}>
            {item.changed ? 'Suggested' : 'No change'}
          </Text>
        </View>
      </View>
      <Text style={styles.coachFeedbackTitle}>{item.title}</Text>
      <Text style={styles.caption}>{item.description}</Text>
      {item.changed && targets.length > 0 ? (
        <View style={styles.coachTargets}>
          {targets.map(([key, value]) => (
            <View key={key} style={styles.coachTargetRow}>
              <Text style={styles.coachTargetLabel}>{coachControlLabels[key]}</Text>
              <Text style={styles.coachTargetValue}>{formatCoachTarget(key, value)}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {item.changed && item.crop ? (
        <Text style={styles.coachCropTarget}>
          Target frame · {Math.round(item.crop.width * 100)}% × {Math.round(item.crop.height * 100)}%
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => onOpenSection(item.section)}
        style={({ pressed }) => [styles.coachReviewButton, pressed && styles.controlPressed]}
      >
        <Text style={styles.coachReviewText}>Review {item.section} controls</Text>
        <MaterialCommunityIcons color={colors.actionText} name="chevron-right" size={20} />
      </Pressable>
    </View>
  );
};

const metadataFields = [
  { key: 'camera', label: 'Camera model', placeholder: 'e.g. Fujifilm X-T5', numeric: false },
  { key: 'lens', label: 'Lens', placeholder: 'e.g. 23mm F2', numeric: false },
  { key: 'iso', label: 'ISO', placeholder: 'e.g. 400', numeric: true },
  { key: 'aperture', label: 'F-stop / aperture', placeholder: 'e.g. f/2.8', numeric: true },
  { key: 'shutterSpeed', label: 'Shutter speed', placeholder: 'e.g. 1/125 s', numeric: true },
  { key: 'focalLength', label: 'Focal length', placeholder: 'e.g. 35 mm', numeric: true },
] satisfies Array<{
  key: keyof EditablePhotoMetadata;
  label: string;
  placeholder: string;
  numeric: boolean;
}>;

const MetadataPanel = ({
  metadata,
  advice,
  busy,
  disabled,
  onChange,
  onCommit,
  onAdvice,
}: {
  metadata: EditablePhotoMetadata;
  advice?: MetadataAdvice;
  busy: boolean;
  disabled: boolean;
  onChange: (key: keyof EditablePhotoMetadata, value: string) => void;
  onCommit: () => void;
  onAdvice: () => void;
}) => {
  const populatedFields = filledMetadataFieldCount(metadata);
  const hasEnoughMetadata = populatedFields > 3;
  const adviceDisabled = busy || disabled || !hasEnoughMetadata;
  const sections = advice ? [
    { title: 'Camera profile', body: advice.cameraProfile },
    { title: 'Lens behavior', body: advice.lensBehavior },
    { title: 'Settings assessment', body: advice.settingsAssessment },
    { title: 'Hardware use', body: advice.hardwareUse },
  ] : [];
  return (
    <>
    <Text style={styles.metaIntro}>Photo metadata is saved automatically and used to ground camera advice.</Text>
    <View style={styles.metaFields}>
      {metadataFields.map((field) => (
        <View key={field.key} style={styles.metaField}>
          <Text style={styles.metaLabel}>{field.label}</Text>
          <TextInput
            accessibilityLabel={field.label}
            autoCapitalize={field.numeric ? 'none' : 'sentences'}
            autoCorrect={false}
            keyboardType={field.numeric ? 'numbers-and-punctuation' : 'default'}
            onBlur={onCommit}
            onChangeText={(value) => onChange(field.key, value)}
            onSubmitEditing={onCommit}
            placeholder={field.placeholder}
            placeholderTextColor={colors.textSecondary}
            returnKeyType="done"
            style={styles.metaInput}
            value={metadata[field.key]}
          />
        </View>
      ))}
    </View>

    {!hasEnoughMetadata ? (
      <Text accessibilityRole="alert" style={styles.metaInsufficient}>
        There isn&apos;t enough information to provide hardware feedback. Fill in at least 4 of the 6 fields above.
      </Text>
    ) : null}

    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: adviceDisabled }}
      disabled={adviceDisabled}
      onPress={onAdvice}
      style={({ pressed }) => [
        styles.metaAdviceButton,
        pressed && styles.primaryPressed,
        adviceDisabled && styles.disabled,
      ]}
    >
      {busy
        ? <ActivityIndicator color={colors.onPrimary} />
        : <Text style={styles.metaAdviceButtonText}>{advice ? 'Regenerate suggestions' : 'Generate suggestions'}</Text>}
    </Pressable>

    {advice ? (
      <View accessibilityLabel="Hardware advice" style={styles.metaAdviceCard}>
        {sections.map((item, index) => (
          <View key={item.title} style={[styles.metaAdviceSection, index === 0 && styles.metaAdviceSectionFirst]}>
            <Text style={styles.metaAdviceSectionTitle}>{item.title}</Text>
            <Text style={styles.metaAdviceReason}>{item.body}</Text>
          </View>
        ))}
        {advice.strength ? (
          <View style={styles.metaStrength}>
            <MaterialCommunityIcons color={colors.success} name="check-circle-outline" size={18} />
            <Text style={styles.metaStrengthText}>{advice.strength}</Text>
          </View>
        ) : null}
      </View>
    ) : null}
    </>
  );
};

const CoachPanel = ({
  analysisBusy,
  applying,
  feedbackBusy,
  feedback,
  metadata,
  metadataAdvice,
  metadataAdviceBusy,
  onAnalyze,
  onAccept,
  onMetadataAdvice,
  onMetadataChange,
  onMetadataCommit,
  onOpenSection,
}: {
  analysisBusy: boolean;
  applying: boolean;
  feedbackBusy: boolean;
  feedback?: CoachFeedbackPlan;
  metadata: EditablePhotoMetadata;
  metadataAdvice?: MetadataAdvice;
  metadataAdviceBusy: boolean;
  onAnalyze: () => void;
  onAccept: () => void;
  onMetadataAdvice: () => void;
  onMetadataChange: (key: keyof EditablePhotoMetadata, value: string) => void;
  onMetadataCommit: () => void;
  onOpenSection: (section: CoachFeedbackSection) => void;
}) => {
  const [section, setSection] = useState<CoachPanelSection>('feedback');
  return (
    <>
      <View accessibilityRole="tablist" style={styles.segmented}>
        {coachPanelSections.map((item) => {
          const selected = item.id === section;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setSection(item.id)}
              style={({ pressed }) => [
                styles.segment,
                selected && styles.segmentActive,
                pressed && (selected ? styles.primaryPressed : styles.controlPressed),
              ]}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {section === 'feedback' ? (
        feedback ? (
          <>
            <Text style={styles.summary}>Four fixes for this photo</Text>
            <Text style={styles.body}>Review each area, then apply the complete adjustment set at once.</Text>
            <View style={styles.coachFeedbackList}>
              {feedback.items.map((item) => (
                <CoachFeedbackCard key={item.section} item={item} onOpenSection={onOpenSection} />
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: applying || analysisBusy }}
              disabled={applying || analysisBusy}
              onPress={onAccept}
              style={({ pressed }) => [
                styles.coachAcceptAll,
                pressed && styles.primaryPressed,
                (applying || analysisBusy) && styles.disabled,
              ]}
            >
              {applying
                ? <ActivityIndicator color={colors.onPrimary} />
                : <Text style={styles.coachAcceptAllText}>Accept all changes</Text>}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: applying || analysisBusy }}
              disabled={applying || analysisBusy}
              onPress={onAnalyze}
              style={({ pressed }) => [
                styles.coachRegenerate,
                pressed && styles.controlPressed,
                (applying || analysisBusy) && styles.disabled,
              ]}
            >
              {feedbackBusy
                ? <ActivityIndicator color={colors.text} />
                : <Text style={styles.coachRegenerateText}>Regenerate suggestions</Text>}
            </Pressable>
          </>
        ) : (
          <View style={styles.centerAction}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: analysisBusy }}
              disabled={analysisBusy}
              onPress={onAnalyze}
              style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed, analysisBusy && styles.disabled]}
            >
              {feedbackBusy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryText}>Analyse photo</Text>}
            </Pressable>
          </View>
        )
      ) : null}

      {section === 'meta' ? (
        <MetadataPanel
          metadata={metadata}
          advice={metadataAdvice}
          busy={metadataAdviceBusy}
          disabled={analysisBusy && !metadataAdviceBusy}
          onChange={onMetadataChange}
          onCommit={onMetadataCommit}
          onAdvice={onMetadataAdvice}
        />
      ) : null}
    </>
  );
};

const AiPanel = ({
  operation,
  prompt,
  target,
  issues,
  busy,
  expansionDirection,
  expansionFraction,
  previewLoading,
  previewReady,
  previewLayerCount,
  loadedLayerCount,
  onOperationChange,
  onPromptChange,
  onTargetChange,
  onGenerate,
  onAccept,
  onDiscard,
  onExpansionDirectionChange,
  onExpansionFractionChange,
}: {
  operation: GenerativeOperation;
  prompt: string;
  target: Region;
  issues: Issue[];
  busy: boolean;
  expansionDirection: ExpansionDirection;
  expansionFraction: number;
  previewLoading: boolean;
  previewReady: boolean;
  previewLayerCount: number;
  loadedLayerCount: number;
  onOperationChange: (operation: GenerativeOperation) => void;
  onPromptChange: (value: string) => void;
  onTargetChange: (target: Region, issueId?: string) => void;
  onGenerate: () => void;
  onAccept: () => void;
  onDiscard: () => void;
  onExpansionDirectionChange: (direction: ExpansionDirection) => void;
  onExpansionFractionChange: (fraction: number) => void;
}) => {
  const selected = (candidate: Region) => JSON.stringify(candidate) === JSON.stringify(target);
  if (previewLoading) {
    return (
      <View accessibilityLabel="Loading generated image layers" style={styles.previewLoading}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.previewLoadingText}>
          Loading {loadedLayerCount} of {previewLayerCount} generated {previewLayerCount === 1 ? 'layer' : 'layers'}…
        </Text>
      </View>
    );
  }
  if (previewReady) {
    return (
      <View accessibilityLabel="AI edit preview actions" style={styles.previewActions}>
        <Pressable accessibilityRole="button" style={styles.previewDiscard} onPress={onDiscard} disabled={busy}>
          <Text style={styles.previewDiscardText}>Discard</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={[styles.previewAccept, busy && styles.disabled]} onPress={onAccept} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.previewAcceptText}>Accept {previewLayerCount === 1 ? 'layer' : `${previewLayerCount} layers`}</Text>}
        </Pressable>
      </View>
    );
  }
  return (
    <>
      <View style={styles.segmented}>
        {(['amplify', 'expand'] as GenerativeOperation[]).map((item) => (
          <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: operation === item }} style={[styles.segment, operation === item && styles.segmentActive]} onPress={() => onOperationChange(item)}>
            <Text style={[styles.segmentText, operation === item && styles.segmentTextActive]}>{item[0].toUpperCase() + item.slice(1)}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>{operation === 'expand' ? 'Expand edge' : 'Drag on photo'}</Text>
      {operation === 'expand' ? (
        <>
          <View style={styles.directionGrid}>
            {(['left', 'top', 'bottom', 'right'] as ExpansionDirection[]).map((direction) => (
              <Pressable
                key={direction}
                accessibilityRole="button"
                accessibilityState={{ selected: expansionDirection === direction }}
                style={[styles.directionButton, expansionDirection === direction && styles.chipActive]}
                onPress={() => onExpansionDirectionChange(direction)}
              >
                <Text style={[styles.chipText, expansionDirection === direction && styles.chipTextActive]}>{direction[0].toUpperCase() + direction.slice(1)}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.expansionAmountRow}>
            <Text style={styles.opacityValue}>{Math.round(expansionFraction * 100)}%</Text>
            <Slider
              style={styles.opacitySlider}
              accessibilityLabel="Canvas expansion amount"
              minimumValue={0.1}
              maximumValue={0.5}
              step={0.05}
              value={expansionFraction}
              onValueChange={onExpansionFractionChange}
              minimumTrackTintColor={colors.primary}
              maximumTrackTintColor={colors.outlineStrong}
              thumbTintColor={colors.text}
            />
          </View>
        </>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {issues.slice(0, 3).map((issue) => (
            <Pressable key={issue.id} accessibilityRole="button" style={[styles.chip, selected(issue.location) && styles.chipActive]} onPress={() => onTargetChange(issue.location, issue.id)}>
              <Text numberOfLines={1} style={[styles.chipText, selected(issue.location) && styles.chipTextActive]}>{issue.title}</Text>
            </Pressable>
          ))}
          {[
            { label: 'Center', region: CENTER_TARGET },
            { label: 'Upper', region: UPPER_TARGET },
            { label: 'Lower', region: LOWER_TARGET },
          ].map((preset) => (
            <Pressable key={preset.label} accessibilityRole="button" style={[styles.chip, selected(preset.region) && styles.chipActive]} onPress={() => onTargetChange(preset.region)}>
              <Text style={[styles.chipText, selected(preset.region) && styles.chipTextActive]}>{preset.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {operation === 'amplify' ? (
        <Text style={styles.generativeHint}>Each independent change becomes its own editable layer.</Text>
      ) : null}
      <TextInput
        accessibilityLabel={operation === 'expand' ? 'Expansion instructions' : 'Amplify instructions'}
        value={prompt}
        onChangeText={onPromptChange}
        multiline
        placeholder={operation === 'expand' ? 'How should the scene continue?' : 'Describe every change you want…'}
        placeholderTextColor={colors.textSecondary}
        style={styles.promptInput}
      />
      <Pressable accessibilityRole="button" style={[styles.primary, (busy || !prompt.trim()) && styles.disabled]} onPress={onGenerate} disabled={busy || !prompt.trim()}>
        {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryText}>{operation === 'expand' ? 'Preview expansion' : 'Preview layers'}</Text>}
      </Pressable>
    </>
  );
};

const MorePanel = ({ onSelect }: { onSelect: (tool: StudioTool) => void }) => (
  <View style={styles.moreGrid}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open layers"
      style={({ pressed }) => [styles.moreButton, pressed && styles.controlPressed]}
      onPress={() => onSelect('layers')}
    >
      <MaterialCommunityIcons name="layers-outline" size={24} color={colors.text} />
      <Text style={styles.moreButtonText}>Layers</Text>
    </Pressable>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open edit history"
      style={({ pressed }) => [styles.moreButton, pressed && styles.controlPressed]}
      onPress={() => onSelect('history')}
    >
      <MaterialCommunityIcons name="history" size={24} color={colors.text} />
      <Text style={styles.moreButtonText}>History</Text>
    </Pressable>
  </View>
);

const LayersPanel = ({
  stack,
  opacities,
  translations,
  selectedLayerId,
  reusableSources,
  showSources,
  importing,
  busyLayerId,
  onSelectLayer,
  onToggleSources,
  onImportPhotos,
  onImportFiles,
  onReuseSource,
  onOpacityChange,
  onOpacityCommit,
  onTranslationChange,
  onTranslationCommit,
  onCommit,
}: {
  stack: LayerStack;
  opacities: Record<string, number>;
  translations: Record<string, LayerTranslation>;
  selectedLayerId?: string;
  reusableSources: ReusableLayerSource[];
  showSources: boolean;
  importing: boolean;
  busyLayerId?: string;
  onSelectLayer: (layerId: string) => void;
  onToggleSources: () => void;
  onImportPhotos: () => void;
  onImportFiles: () => void;
  onReuseSource: (source: ReusableLayerSource) => void;
  onOpacityChange: (layerId: string, opacity: number) => void;
  onOpacityCommit: (layerId: string, opacity: number) => void;
  onTranslationChange: (layerId: string, translation: LayerTranslation) => void;
  onTranslationCommit: (layerId: string, translation: LayerTranslation) => void;
  onCommit: (stack: LayerStack, label: string) => Promise<boolean>;
}) => (
  <>
    <View style={styles.layersHeader}>
      <View style={styles.layerInfo}>
        <Text style={styles.layersTitle}>Layer stack</Text>
        <Text style={styles.caption}>Tap a layer to edit it. Drag spatial layers on the photo.</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={showSources ? 'Close image layer sources' : 'Add image layer'}
        style={({ pressed }) => [styles.addLayerButton, pressed && styles.controlPressed]}
        onPress={onToggleSources}
        disabled={importing}
      >
        {importing
          ? <ActivityIndicator size="small" color={colors.onPrimary} />
          : <MaterialCommunityIcons name={showSources ? 'close' : 'plus'} size={22} color={colors.onPrimary} />}
        <Text style={styles.addLayerButtonText}>{showSources ? 'Close' : 'Add image'}</Text>
      </Pressable>
    </View>

    {showSources ? (
      <View style={styles.layerSources}>
        <View style={styles.sourceActions}>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.sourceAction, pressed && styles.controlPressed]}
            onPress={onImportPhotos}
            disabled={importing}
          >
            <MaterialCommunityIcons name="image-multiple-outline" size={22} color={colors.text} />
            <Text style={styles.sourceActionText}>Photos</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.sourceAction, pressed && styles.controlPressed]}
            onPress={onImportFiles}
            disabled={importing}
          >
            <MaterialCommunityIcons name="folder-outline" size={22} color={colors.text} />
            <Text style={styles.sourceActionText}>Files</Text>
          </Pressable>
        </View>
        <Text style={styles.sourceTitle}>Previously used</Text>
        {reusableSources.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.recentSources}
          >
            {reusableSources.map((source) => (
              <Pressable
                key={source.sourceAssetId}
                accessibilityRole="button"
                accessibilityLabel={`Reuse ${source.name}`}
                style={({ pressed }) => [styles.recentSource, pressed && styles.controlPressed]}
                onPress={() => onReuseSource(source)}
                disabled={importing}
              >
                <Image accessibilityIgnoresInvertColors source={{ uri: source.uri }} resizeMode="cover" style={styles.sourceThumbnail} />
                <Text numberOfLines={1} style={styles.sourceName}>{source.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <Text style={styles.sourceEmpty}>Images you add will appear here for quick reuse.</Text>
        )}
      </View>
    ) : null}

    {stack.layers.length === 0 ? (
      <View style={styles.layerEmpty}>
        <MaterialCommunityIcons name="layers-plus" size={30} color={colors.textSecondary} />
        <Text style={styles.layerEmptyTitle}>Your original stays untouched</Text>
        <Text style={styles.sourceEmpty}>Add an image as a new layer, then position and blend it independently.</Text>
      </View>
    ) : null}
    {[...stack.layers].reverse().map((layer, reverseIndex) => {
      const index = stack.layers.length - 1 - reverseIndex;
      const opacity = opacities[layer.id] ?? layer.opacity;
      const translation = translations[layer.id] ?? layerTranslation(layer);
      const selected = selectedLayerId === layer.id;
      const busy = Boolean(busyLayerId);
      return (
        <View key={layer.id} style={[styles.layerBlock, selected && styles.layerBlockSelected]}>
          <View style={[styles.layerRow, !layer.enabled && styles.layerDisabled]}>
            <Pressable accessibilityRole="switch" accessibilityState={{ checked: layer.enabled }} accessibilityLabel={`${layer.enabled ? 'Hide' : 'Show'} ${layer.name}`} style={styles.layerControl} disabled={busy} onPress={() => onCommit(toggleLayer(stack, layer.id), `${layer.enabled ? 'Hide' : 'Show'} ${layer.name}`)}>
              <MaterialCommunityIcons name={layer.enabled ? 'eye' : 'eye-off-outline'} size={20} color={colors.primary} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Edit ${layer.name}`}
              style={styles.layerSelect}
              onPress={() => onSelectLayer(layer.id)}
            >
              <Text numberOfLines={1} style={styles.layerName}>{layer.name}</Text>
              <Text style={styles.layerKind}>{layer.type.replace(/-/g, ' ')}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Move ${layer.name} up`} style={styles.layerControl} onPress={() => onCommit(reorderLayer(stack, layer.id, 1), `Move ${layer.name}`)} disabled={index === stack.layers.length - 1 || busy}><MaterialCommunityIcons name="arrow-up" size={20} color={colors.text} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Move ${layer.name} down`} style={styles.layerControl} onPress={() => onCommit(reorderLayer(stack, layer.id, -1), `Move ${layer.name}`)} disabled={index === 0 || busy}><MaterialCommunityIcons name="arrow-down" size={20} color={colors.text} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${layer.name}`} style={styles.layerControl} onPress={() => onCommit(removeLayer(stack, layer.id), `Remove ${layer.name}`)} disabled={busy}><MaterialCommunityIcons name="close" size={22} color={colors.danger} /></Pressable>
          </View>
          <View style={styles.opacityRow}>
            <Text style={styles.opacityValue}>{Math.round(opacity * 100)}%</Text>
            <Slider
              style={styles.opacitySlider}
              accessibilityLabel={`${layer.name} opacity`}
              accessibilityHint="Changes apply when you release the slider"
              minimumValue={0}
              maximumValue={1}
              step={0.01}
              value={opacity}
              disabled={busy}
              onValueChange={(value) => onOpacityChange(layer.id, value)}
              onSlidingComplete={(value) => onOpacityCommit(layer.id, value)}
              minimumTrackTintColor={colors.primary}
              maximumTrackTintColor={colors.outline}
              thumbTintColor={colors.text}
            />
          </View>
          {selected ? (
            isTranslatableLayer(layer) ? (
              <LayerPositionControls
                layer={layer}
                translation={translation}
                disabled={busy || !layer.enabled}
                onChange={(next) => onTranslationChange(layer.id, next)}
                onCommit={(next) => onTranslationCommit(layer.id, next)}
              />
            ) : (
              <Text style={styles.globalLayerHint}>This layer affects the full image, so it has no canvas position.</Text>
            )
          ) : null}
        </View>
      );
    })}
  </>
);

const LayerPositionControls = ({
  layer,
  translation,
  disabled,
  onChange,
  onCommit,
}: {
  layer: TranslatableLayer;
  translation: LayerTranslation;
  disabled: boolean;
  onChange: (translation: LayerTranslation) => void;
  onCommit: (translation: LayerTranslation) => void;
}) => {
  const axis = (key: keyof LayerTranslation, label: string) => (
    <View style={styles.positionAxis}>
      <Text style={styles.axisLabel}>{label}</Text>
      <Slider
        style={styles.positionSlider}
        accessibilityLabel={`${layer.name} ${label.toLowerCase()} position`}
        accessibilityHint="Move the layer from minus one canvas length to plus one canvas length"
        minimumValue={-1}
        maximumValue={1}
        step={0.01}
        value={translation[key]}
        disabled={disabled}
        onValueChange={(value) => onChange({ ...translation, [key]: value })}
        onSlidingComplete={(value) => onCommit({ ...translation, [key]: value })}
        minimumTrackTintColor={colors.primary}
        maximumTrackTintColor={colors.outline}
        thumbTintColor={colors.text}
      />
      <Text style={styles.axisValue}>{Math.round(translation[key] * 100)}%</Text>
    </View>
  );
  return (
    <View style={styles.positionControls}>
      <View style={styles.positionHeader}>
        <View style={styles.layerInfo}>
          <Text style={styles.positionTitle}>Position</Text>
          <Text style={styles.positionHint}>{disabled ? 'Show this layer to position it.' : 'Drag on the photo, or use the sliders for precision.'}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Center ${layer.name}`}
          style={({ pressed }) => [styles.centerLayerButton, pressed && styles.controlPressed, (disabled || (translation.x === 0 && translation.y === 0)) && styles.disabled]}
          disabled={disabled || (translation.x === 0 && translation.y === 0)}
          onPress={() => {
            const centered = { x: 0, y: 0 };
            onChange(centered);
            onCommit(centered);
          }}
        >
          <MaterialCommunityIcons name="image-filter-center-focus" size={19} color={colors.text} />
          <Text style={styles.centerLayerText}>Center</Text>
        </Pressable>
      </View>
      {axis('x', 'X')}
      {axis('y', 'Y')}
    </View>
  );
};

const HistoryPanel = ({ photo, onRestore }: { photo: NonNullable<ReturnType<typeof useExposure>['selectedPhoto']>; onRestore: (versionId: string) => Promise<void> }) => (
  <>
    {[...photo.versions].reverse().map((item, index) => (
      <View key={item.id} style={styles.historyRow}>
        <View style={[styles.timelineDot, item.id === photo.currentVersionId && styles.timelineDotActive]} />
        <View style={styles.layerInfo}>
          <Text style={styles.layerName}>{item.label}</Text>
          <Text style={styles.caption}>{new Date(item.createdAt).toLocaleString()}</Text>
        </View>
        {index !== 0 ? (
          <Pressable accessibilityRole="button" style={styles.restoreButton} onPress={() => onRestore(item.id)}><Text style={styles.restore}>Restore</Text></Pressable>
        ) : <Text style={styles.current}>Current</Text>}
      </View>
    ))}
  </>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 58, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator, backgroundColor: colors.surface },
  headerButton: { width: 88, height: 48, alignItems: 'flex-start', justifyContent: 'center', paddingLeft: 12 },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { color: colors.text, fontWeight: '800', fontSize: 16 },
  exportButton: { width: 88, minHeight: 48, borderRadius: 8, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  exportButtonText: { color: colors.onPrimary, fontSize: 12, fontWeight: '800' },
  canvas: { flex: 1, minHeight: 190 },
  panel: { maxHeight: '50%', minHeight: 214, backgroundColor: colors.surface },
  panelContent: { flexGrow: 1, padding: 16, paddingBottom: 20 },
  message: { color: colors.text, backgroundColor: colors.surfaceStrong, fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingVertical: 10 },
  centerAction: { flex: 1, minHeight: 100, justifyContent: 'center' },
  primary: { backgroundColor: colors.primary, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, paddingHorizontal: 16 },
  primaryText: { color: colors.onPrimary, fontWeight: '800', fontSize: 13 },
  previewTitle: { color: colors.text, fontSize: 15, lineHeight: 20, fontWeight: '800', marginBottom: 12 },
  previewLoading: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  previewLoadingText: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  previewActions: { flexDirection: 'row', gap: 12, minHeight: 52 },
  previewDiscard: { flex: 1, minHeight: 52, borderRadius: 8, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.outlineStrong, alignItems: 'center', justifyContent: 'center' },
  previewDiscardText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  previewAccept: { flex: 1, minHeight: 52, borderRadius: 8, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  previewAcceptText: { color: colors.onPrimary, fontSize: 14, fontWeight: '800' },
  summary: { color: colors.text, fontSize: 18, fontWeight: '800', lineHeight: 23 },
  body: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 4 },
  caption: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  chips: { gap: 8, paddingVertical: 12 },
  chip: { minHeight: 48, maxWidth: 240, borderRadius: 24, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.controlSurface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.onControlSurface, fontSize: 12, fontWeight: '700' },
  chipTextActive: { color: colors.onPrimary },
  directionGrid: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  directionButton: { flex: 1, minHeight: 48, borderRadius: 8, borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.controlSurface, alignItems: 'center', justifyContent: 'center' },
  expansionAmountRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  generativeHint: { color: colors.textSecondary, fontSize: 12, lineHeight: 18, marginBottom: 10 },
  focusedFinding: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  findingTitle: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '800' },
  findingActions: { flexDirection: 'row', gap: 18 },
  inlineAction: { alignSelf: 'flex-start', minHeight: 48, justifyContent: 'center', marginTop: 4 },
  inlineActionText: { color: colors.actionText, fontSize: 12, fontWeight: '800' },
  dismissActionText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  section: { marginTop: 16 },
  sectionTitle: { color: colors.text, fontSize: 13, fontWeight: '800', marginBottom: 8 },
  adviceRow: { minHeight: 54, flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 7, borderBottomColor: colors.separator, borderBottomWidth: StyleSheet.hairlineWidth },
  adviceSetting: { width: 88, color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  adviceBody: { flex: 1 },
  adviceValue: { color: colors.text, fontSize: 13, fontWeight: '700', marginBottom: 2 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  actionCopy: { flex: 1 },
  smallPrimary: { minWidth: 68, minHeight: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, borderRadius: 8 },
  smallPrimaryText: { color: colors.onPrimary, fontSize: 12, fontWeight: '800' },
  askRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  askInput: { flex: 1, minHeight: 48, color: colors.text, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.outline, borderRadius: 8, paddingHorizontal: 12, fontSize: 13 },
  askButton: { minWidth: 64, minHeight: 48, borderRadius: 8, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  askButtonText: { color: colors.onPrimary, fontSize: 12, fontWeight: '800' },
  coachFeedbackList: { gap: 10, marginTop: 16 },
  coachFeedbackCard: { padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.separator, backgroundColor: colors.background },
  coachFeedbackHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 9 },
  coachFeedbackSectionTitle: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  coachFeedbackSectionLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
  coachFeedbackStatus: { minHeight: 24, borderRadius: 12, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  coachFeedbackStatusIdle: { backgroundColor: colors.surfaceStrong },
  coachFeedbackStatusText: { color: colors.onPrimary, fontSize: 10, fontWeight: '800' },
  coachFeedbackStatusTextIdle: { color: colors.textSecondary },
  coachFeedbackTitle: { color: colors.text, fontSize: 15, lineHeight: 20, fontWeight: '800', marginBottom: 4 },
  coachTargets: { marginTop: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  coachTargetRow: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  coachTargetLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  coachTargetValue: { color: colors.text, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  coachCropTarget: { color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 10 },
  coachReviewButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 7, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 8 },
  coachReviewText: { color: colors.actionText, fontSize: 12, fontWeight: '800' },
  coachAcceptAll: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: colors.primary, marginTop: 14 },
  coachAcceptAllText: { color: colors.onPrimary, fontSize: 14, fontWeight: '800' },
  coachRegenerate: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: colors.outlineStrong, backgroundColor: colors.surfaceStrong, marginTop: 10 },
  coachRegenerateText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  metaIntro: { color: colors.textSecondary, fontSize: 12, lineHeight: 18, marginBottom: 14 },
  metaFields: { gap: 12 },
  metaField: { gap: 6 },
  metaLabel: { color: colors.text, fontSize: 12, fontWeight: '800' },
  metaInput: { minHeight: 48, color: colors.text, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.outline, borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  metaInsufficient: { color: colors.warning, fontSize: 12, lineHeight: 18, marginTop: 14 },
  metaAdviceButton: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: colors.primary, marginTop: 16 },
  metaAdviceButtonText: { color: colors.onPrimary, fontSize: 14, fontWeight: '800' },
  metaAdviceCard: { marginTop: 14, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.background },
  metaAdviceSection: { paddingTop: 13, marginTop: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  metaAdviceSectionFirst: { paddingTop: 0, marginTop: 0, borderTopWidth: 0 },
  metaAdviceSectionTitle: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: '800' },
  metaAdviceReason: { color: colors.textSecondary, fontSize: 13, lineHeight: 20, marginTop: 5 },
  metaStrength: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingTop: 13, marginTop: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  metaStrengthText: { flex: 1, color: colors.text, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  segmented: { flexDirection: 'row', minHeight: 56, borderRadius: 10, padding: 4, backgroundColor: colors.background, marginBottom: 16 },
  segment: { flex: 1, minHeight: 48, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segmentActive: { backgroundColor: colors.primary },
  primaryPressed: { backgroundColor: colors.primaryPressed },
  controlPressed: { backgroundColor: colors.controlPressed },
  segmentText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: colors.onPrimary },
  promptInput: { minHeight: 76, color: colors.text, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.outline, borderRadius: 8, padding: 12, textAlignVertical: 'top', marginBottom: 12, fontSize: 13 },
  disabled: { opacity: 0.45 },
  placeholder: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  moreGrid: { flexDirection: 'row', gap: 12 },
  moreButton: { flex: 1, minHeight: 72, borderRadius: 10, borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.controlSurface, alignItems: 'center', justifyContent: 'center', gap: 6 },
  moreButtonText: { color: colors.onControlSurface, fontSize: 13, fontWeight: '700' },
  layersHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  layersTitle: { color: colors.text, fontSize: 16, lineHeight: 21, fontWeight: '800', marginBottom: 2 },
  addLayerButton: { minWidth: 106, minHeight: 48, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  addLayerButtonText: { color: colors.onPrimary, fontSize: 12, fontWeight: '800' },
  layerSources: { padding: 12, borderRadius: 10, backgroundColor: colors.background, marginBottom: 12 },
  sourceActions: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  sourceAction: { flex: 1, minHeight: 52, borderRadius: 8, borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.controlSurface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  sourceActionText: { color: colors.onControlSurface, fontSize: 13, fontWeight: '800' },
  sourceTitle: { color: colors.text, fontSize: 12, lineHeight: 17, fontWeight: '800', marginBottom: 8 },
  recentSources: { gap: 10, paddingRight: 4 },
  recentSource: { width: 104, minHeight: 96, borderRadius: 8, padding: 6, backgroundColor: colors.controlSurface },
  sourceThumbnail: { width: 92, height: 58, borderRadius: 6, backgroundColor: colors.surfaceStrong, marginBottom: 5 },
  sourceName: { color: colors.onControlSurface, fontSize: 11, lineHeight: 15, fontWeight: '700' },
  sourceEmpty: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  layerEmpty: { minHeight: 144, alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 24 },
  layerEmptyTitle: { color: colors.text, fontSize: 14, lineHeight: 19, fontWeight: '800', textAlign: 'center' },
  layerBlock: { paddingHorizontal: 8, paddingBottom: 8, borderBottomColor: colors.separator, borderBottomWidth: StyleSheet.hairlineWidth },
  layerBlockSelected: { backgroundColor: colors.surfaceStrong, borderRadius: 10 },
  layerRow: { minHeight: 54, flexDirection: 'row', gap: 2, alignItems: 'center' },
  layerDisabled: { opacity: 0.48 },
  layerControl: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  layerSelect: { flex: 1, minHeight: 48, justifyContent: 'center', paddingHorizontal: 4 },
  layerInfo: { flex: 1 },
  layerName: { color: colors.text, fontSize: 13, fontWeight: '700' },
  layerKind: { color: colors.text, fontSize: 11, lineHeight: 15, marginTop: 2, textTransform: 'capitalize' },
  opacityRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingLeft: 48, paddingRight: 4 },
  opacityValue: { width: 42, color: colors.text, fontSize: 11, fontVariant: ['tabular-nums'] },
  opacitySlider: { flex: 1, height: 48 },
  positionControls: { marginLeft: 48, marginRight: 4, paddingTop: 10, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  positionHeader: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 },
  positionTitle: { color: colors.text, fontSize: 12, lineHeight: 17, fontWeight: '800' },
  positionHint: { color: colors.text, fontSize: 11, lineHeight: 15, marginTop: 1 },
  centerLayerButton: { minWidth: 78, minHeight: 44, paddingHorizontal: 8, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: colors.controlSurface },
  centerLayerText: { color: colors.onControlSurface, fontSize: 11, fontWeight: '800' },
  positionAxis: { minHeight: 48, flexDirection: 'row', alignItems: 'center' },
  axisLabel: { width: 22, color: colors.text, fontSize: 12, fontWeight: '800' },
  positionSlider: { flex: 1, height: 48 },
  axisValue: { width: 44, color: colors.text, fontSize: 11, textAlign: 'right', fontVariant: ['tabular-nums'] },
  globalLayerHint: { color: colors.text, fontSize: 11, lineHeight: 16, marginLeft: 48, paddingBottom: 8 },
  historyRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomColor: colors.separator, borderBottomWidth: StyleSheet.hairlineWidth },
  timelineDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.textSecondary },
  timelineDotActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  restoreButton: { minWidth: 64, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  restore: { color: colors.actionText, fontSize: 11, fontWeight: '800' },
  current: { color: colors.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: '800', paddingHorizontal: 8 },
  empty: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  emptyButton: { minHeight: 48, justifyContent: 'center' },
  link: { color: colors.actionText, fontSize: 13, fontWeight: '700' },
});
