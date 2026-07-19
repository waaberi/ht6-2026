import { randomUUID } from 'expo-crypto';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PhotoCanvas } from '../components/PhotoCanvas';
import { AdjustmentSheet, type AdjustmentSection } from '../components/studio/AdjustmentSheet';
import { LooksPanel } from '../components/studio/LooksPanel';
import { StudioToolRail, type StudioTool } from '../components/studio/StudioToolRail';
import { colors } from '../components/theme';
import { deleteGeneratedLayerAsset, saveGeneratedLayerAsset } from '../data/photoRepository';
import { recordRecommendationFeedback } from '../data/preferences';
import { loadStyleProfiles, type SavedStyleProfile } from '../data/styleRepository';
import { centeredCrop, restoreManualTransform, rotateClockwise, withStraighten } from '../domain/canvasTransforms';
import {
  buildCoachEditPreview,
  isCoachEditPreviewCurrent,
  isPreviewableCoachActionPlan,
  planCoachAction,
  type CoachEditPreview,
  type PreviewableCoachActionPlan,
} from '../domain/coachHarness';
import { collectiveAdjustmentValues, currentVersion, mergeCollectiveAdjustments, removeLayer, reorderLayer, setCollectiveAdjustments, setLayerOpacity, StalePhotoVersionError, toggleLayer } from '../domain/layers';
import type {
  AdjustmentValues,
  CanvasTransform,
  CoachAction,
  CoachResponse,
  GenerativeOperation,
  GenerativePatchLayer,
  Issue,
  LayerStack,
  Region,
  StyleLayer,
} from '../domain/types';
import { ApiUnavailableError, askCoach, createGenerativePatch } from '../services/api';
import { exportAndShare } from '../services/export';
import { persistPreferences } from '../services/sync';
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
  layer: GenerativePatchLayer;
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

const aspectLabel = (aspect: number) => {
  if (Math.abs(aspect - 1) < 0.001) return '1:1';
  if (Math.abs(aspect - 4 / 3) < 0.001) return '4:3';
  if (Math.abs(aspect - 3 / 4) < 0.001) return '3:4';
  if (Math.abs(aspect - 16 / 9) < 0.001) return '16:9';
  if (Math.abs(aspect - 9 / 16) < 0.001) return '9:16';
  return aspect.toFixed(2);
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
    selectedPhoto,
    analysis,
    analyzing,
    commitStack,
    restore,
    runAnalysis,
  } = useExposure();
  const [tool, setTool] = useState<StudioTool>('coach');
  const [adjustmentSection, setAdjustmentSection] = useState<AdjustmentSection>('light');
  const [cropAspect, setCropAspect] = useState<number>();
  const [previewImageSize, setPreviewImageSize] = useState<{ uri: string; width: number; height: number }>();
  const [message, setMessage] = useState<string>();
  const [coachResponse, setCoachResponse] = useState<CoachResponse>();
  const [coachQuestion, setCoachQuestion] = useState('');
  const [coachBusy, setCoachBusy] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string>();
  const [dismissedIssueIds, setDismissedIssueIds] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [draftAdjustments, setDraftAdjustments] = useState<AdjustmentValues>({});
  const [assetBusy, setAssetBusy] = useState(false);
  const [generativeOperation, setGenerativeOperation] = useState<GenerativeOperation>('remove');
  const [generativePrompt, setGenerativePrompt] = useState('Remove the selected distraction and reconstruct the background.');
  const [generativeTarget, setGenerativeTarget] = useState<Region>(CENTER_TARGET);
  const [generativeRecommendationId, setGenerativeRecommendationId] = useState<string>();
  const [expansionDirection, setExpansionDirection] = useState<ExpansionDirection>('right');
  const [expansionFraction, setExpansionFraction] = useState(0.25);
  const [generativeDraft, setGenerativeDraft] = useState<GenerativeDraft>();
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
  const [draftTransform, setDraftTransform] = useState<CanvasTransform>(() => identityCanvasTransform());
  const [draftLayerOpacities, setDraftLayerOpacities] = useState<Record<string, number>>({});
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

  const deleteDraftAssets = useCallback((draft: GenerativeDraft) => {
    deleteGeneratedLayerAsset(draft.layer.patchAssetId);
    deleteGeneratedLayerAsset(draft.layer.maskAssetId);
  }, []);

  const releaseGenerativeDraft = useCallback((deleteAssets: boolean) => {
    const draft = generativeDraftRef.current;
    if (draft && deleteAssets) deleteDraftAssets(draft);
    generativeDraftRef.current = undefined;
    if (mountedRef.current) setGenerativeDraft(undefined);
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
    loadStyleProfiles()
      .then((looks) => { if (active) setSavedLooks(looks); })
      .catch(() => { if (active) setMessage('Saved Looks could not be loaded.'); })
      .finally(() => { if (active) setLooksLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setDraftAdjustments(savedAdjustments);
  }, [savedAdjustments, version?.id]);

  useEffect(() => {
    setCoachResponse(undefined);
  }, [version?.id]);

  useEffect(() => {
    setSelectedLookId(appliedLookLayer?.styleProfileId);
    setLookStrength(appliedLookLayer?.strength ?? 0.75);
    setLookDraftLayerId(appliedLookLayer?.id ?? randomUUID());
  }, [appliedLookLayer?.id, appliedLookLayer?.strength, appliedLookLayer?.styleProfileId, version?.id]);

  useEffect(() => {
    if (!version) return;
    setDraftTransform(version.stack.canvasTransform);
    setDraftLayerOpacities(Object.fromEntries(version.stack.layers.map((layer) => [layer.id, layer.opacity])));
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
  }, [appliedLookLayer?.createdAt, appliedLookLayer?.id, coachEditDraft, coachPreviewComparison, draftAdjustments, draftLayerOpacities, draftTransform, generativeDraft, lookDraftLayerId, lookStrength, selectedLook, selectedPhoto?.id, tool, version]);

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

  const openGenerativeTool = (operation: GenerativeOperation, target: Region, prompt: string, recommendationIssueId?: string) => {
    setGenerativeOperation(operation);
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
      openGenerativeTool(
        issue.fix.kind === 'retouch' ? 'remove' : 'add',
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
    setMessage(undefined);
    try {
      const result = await runAnalysis();
      const firstIssue = result.issues[0];
      setDismissedIssueIds([]);
      setSelectedIssueId(firstIssue?.id);
      if (firstIssue) setGenerativeTarget(firstIssue.location);
    } catch (error) {
      setMessage(error instanceof ApiUnavailableError ? error.message : error instanceof Error ? error.message : 'Analysis failed.');
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
        openGenerativeTool(plan.operation, plan.target, plan.prompt, selectedIssue?.id);
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
    const sourceVersionId = version.id;
    const sourcePhotoId = selectedPhoto.id;
    setMessage(undefined);
    setAssetBusy(true);
    let patchAssetId: string | undefined;
    let maskAssetId: string | undefined;
    try {
      const result = await createGenerativePatch(
        selectedPhoto,
        version.stack,
        generativeTarget,
        generativePrompt.trim(),
        generativeOperation,
        expansionDirection,
        expansionFraction,
      );
      if (result.sourceVersionId !== sourceVersionId) throw new StalePhotoVersionError();
      if (!mountedRef.current) return;
      if (
        currentSelectionRef.current.photoId !== sourcePhotoId
        || currentSelectionRef.current.versionId !== sourceVersionId
      ) throw new StalePhotoVersionError();
      patchAssetId = randomUUID();
      maskAssetId = randomUUID();
      const patchUri = saveGeneratedLayerAsset(patchAssetId, result.patchBase64);
      const maskUri = saveGeneratedLayerAsset(maskAssetId, result.maskBase64);
      const label = generativeOperation === 'remove'
        ? `Removed ${explicitRecommendation?.title.toLowerCase() ?? 'selection'}`
        : generativeOperation === 'expand'
          ? `Expanded ${expansionDirection}`
          : `Added ${generativePrompt.trim().slice(0, 42)}`;
      const generatedLayer: GenerativePatchLayer = {
        id: randomUUID(), type: 'generative-patch', name: label, enabled: true, opacity: 1,
        createdAt: new Date().toISOString(), patchAssetId, patchUri, maskAssetId, maskUri,
        target: result.target, prompt: generativePrompt.trim(),
        canvasSpace: true,
        canvasExpansion: result.expansion ?? version.stack.canvasTransform.expansion ?? { top: 0, right: 0, bottom: 0, left: 0 },
        provenance: { model: result.model, sourceVersionId: result.sourceVersionId, driftScore: result.driftScore },
      };
      let candidateStack: LayerStack;
      if (generativeOperation === 'expand') {
        if (!result.expansion) throw new Error('The expansion result did not include canvas geometry.');
        candidateStack = {
          ...version.stack,
          canvasTransform: { ...version.stack.canvasTransform, expansion: result.expansion },
          layers: [...version.stack.layers, generatedLayer],
        };
      } else {
        candidateStack = { ...version.stack, layers: [...version.stack.layers, generatedLayer] };
      }
      const draft: GenerativeDraft = {
        sourcePhotoId,
        sourceVersionId,
        label,
        stack: candidateStack,
        layer: generatedLayer,
        recommendation: explicitRecommendation,
      };
      generativeDraftRef.current = draft;
      setGenerativeDraft(draft);
      patchAssetId = undefined;
      maskAssetId = undefined;
    } catch (error) {
      if (patchAssetId) deleteGeneratedLayerAsset(patchAssetId);
      if (maskAssetId) deleteGeneratedLayerAsset(maskAssetId);
      if (mountedRef.current) setMessage(error instanceof Error ? error.message : 'AI edit failed.');
    } finally {
      if (mountedRef.current) setAssetBusy(false);
    }
  };

  const acceptGenerativeDraft = async () => {
    const draft = generativeDraftRef.current;
    if (!draft) return;
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

  const selectIssue = (issue: Issue) => {
    setSelectedIssueId(issue.id);
    setGenerativeTarget(issue.location);
  };

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
          target={tool === 'ai' && generativeOperation !== 'expand' ? generativeTarget : undefined}
          onTargetChange={tool === 'ai' && generativeOperation !== 'expand' ? updateGenerativeTarget : undefined}
          showIssues={tool === 'coach' && !coachEditDraft}
          editingCrop={tool === 'adjust' && adjustmentSection === 'crop'}
          cropRegion={draftTransform.crop}
          cropAspect={cropAspect}
          onCropChange={(crop) => setDraftTransform((current) => ({ ...current, crop }))}
          onCropCommit={(crop) => void commitTransform({ ...draftTransform, crop }, 'Crop')}
          onImageSizeChange={handlePreviewImageSizeChange}
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
                analysis={analysis}
                analyzing={analyzing}
                selectedIssue={selectedIssue}
                response={coachResponse}
                question={coachQuestion}
                coachBusy={coachBusy}
                applying={applying}
                onAnalyze={analyze}
                onSelectIssue={selectIssue}
                issues={visibleIssues}
                onDismissIssue={(issue) => void dismissRecommendation(issue)}
                onQuestionChange={setCoachQuestion}
                onAsk={ask}
                onApplyIssue={applyIssue}
                onApplyAction={applyCoachAction}
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
              canRestore={Boolean(appliedLookLayer)}
              onSelect={(look) => void chooseLook(look)}
              onStrengthChange={setLookStrength}
              onStrengthCommit={(strength) => void commitLookStrength(strength)}
              onRestore={() => void restoreLook()}
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
              previewReady={Boolean(generativeDraft)}
              onOperationChange={(operation) => {
                setGenerativeOperation(operation);
                setGenerativeRecommendationId(undefined);
                setGenerativePrompt(operation === 'remove'
                  ? 'Remove the selected distraction and reconstruct the background.'
                  : operation === 'expand'
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
              busyLayerId={layerBusyId}
              onOpacityChange={(layerId, opacity) => setDraftLayerOpacities((current) => ({ ...current, [layerId]: opacity }))}
              onOpacityCommit={(layerId, opacity) => void commitLayerOpacity(layerId, opacity)}
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

const CoachPanel = ({
  analysis,
  analyzing,
  selectedIssue,
  response,
  question,
  coachBusy,
  applying,
  onAnalyze,
  onSelectIssue,
  issues,
  onDismissIssue,
  onQuestionChange,
  onAsk,
  onApplyIssue,
  onApplyAction,
}: {
  analysis: ReturnType<typeof useExposure>['analysis'];
  analyzing: boolean;
  selectedIssue?: Issue;
  response?: CoachResponse;
  question: string;
  coachBusy: boolean;
  applying: boolean;
  onAnalyze: () => void;
  onSelectIssue: (issue: Issue) => void;
  issues: Issue[];
  onDismissIssue: (issue: Issue) => void;
  onQuestionChange: (value: string) => void;
  onAsk: () => void;
  onApplyIssue: (issue: Issue) => void;
  onApplyAction: (action: CoachAction) => void;
}) => {
  if (!analysis) {
    return (
      <View style={styles.centerAction}>
        <Pressable accessibilityRole="button" style={styles.primary} onPress={onAnalyze} disabled={analyzing}>
          {analyzing ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryText}>Analyze photo</Text>}
        </Pressable>
      </View>
    );
  }
  const fixable = Boolean(selectedIssue?.fix);
  const captureAdvice = response?.captureAdvice.length ? response.captureAdvice : analysis.cameraRecommendations;
  return (
    <>
      <Text numberOfLines={2} style={styles.summary}>{response?.headline ?? analysis.summary}</Text>
      {response?.reason ? <Text numberOfLines={3} style={styles.body}>{response.reason}</Text> : null}

      {issues.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {issues.slice(0, 6).map((issue) => (
            <Pressable
              key={issue.id}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedIssue?.id === issue.id }}
              onPress={() => onSelectIssue(issue)}
              style={[styles.chip, selectedIssue?.id === issue.id && styles.chipActive]}
            >
              <Text numberOfLines={1} style={[styles.chipText, selectedIssue?.id === issue.id && styles.chipTextActive]}>{issue.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {selectedIssue ? (
        <View style={styles.focusedFinding}>
          <Text numberOfLines={2} style={styles.body}>{selectedIssue.explanation}</Text>
          <View style={styles.findingActions}>
            {fixable ? (
              <Pressable accessibilityRole="button" style={styles.inlineAction} onPress={() => onApplyIssue(selectedIssue)} disabled={applying}>
                <Text style={styles.inlineActionText}>{selectedIssue.fix?.kind === 'retake' ? 'Retake' : 'Preview'}</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" style={styles.inlineAction} onPress={() => onDismissIssue(selectedIssue)} disabled={applying}>
              <Text style={styles.dismissActionText}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {captureAdvice.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Capture advice</Text>
          {captureAdvice.map((advice, index) => (
            <View key={`${advice.setting}-${index}`} style={styles.adviceRow}>
              <Text numberOfLines={1} style={styles.adviceSetting}>{advice.setting.replace('-', ' ')}</Text>
              <View style={styles.adviceBody}>
                {advice.value ? <Text numberOfLines={1} style={styles.adviceValue}>{advice.value}</Text> : null}
                {'tradeoff' in advice && advice.tradeoff ? <Text numberOfLines={2} style={styles.caption}>{advice.tradeoff}</Text> : null}
                {'explanation' in advice ? <Text numberOfLines={2} style={styles.caption}>{advice.explanation}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {response?.actions.map((action) => (
        <View key={action.id} style={styles.actionRow}>
          <View style={styles.actionCopy}><Text numberOfLines={1} style={styles.findingTitle}>{action.label}</Text><Text numberOfLines={2} style={styles.caption}>{action.reason}</Text></View>
          <Pressable accessibilityRole="button" style={styles.smallPrimary} onPress={() => onApplyAction(action)}>
            <Text style={styles.smallPrimaryText}>{action.tool === 'retake' ? 'Retake' : 'Preview'}</Text>
          </Pressable>
        </View>
      ))}

      <View style={styles.askRow}>
        <TextInput
          accessibilityLabel="Ask the photo coach"
          value={question}
          onChangeText={onQuestionChange}
          onSubmitEditing={onAsk}
          placeholder="Ask about this photo"
          placeholderTextColor={colors.textSecondary}
          style={styles.askInput}
        />
        <Pressable accessibilityRole="button" style={styles.askButton} onPress={onAsk} disabled={coachBusy || !question.trim()}>
          {coachBusy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.askButtonText}>Ask</Text>}
        </Pressable>
      </View>
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
  previewReady,
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
  previewReady: boolean;
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
  if (previewReady) {
    return (
      <View accessibilityLabel="AI edit preview actions" style={styles.previewActions}>
        <Pressable accessibilityRole="button" style={styles.previewDiscard} onPress={onDiscard} disabled={busy}>
          <Text style={styles.previewDiscardText}>Discard</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={[styles.previewAccept, busy && styles.disabled]} onPress={onAccept} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.previewAcceptText}>Accept</Text>}
        </Pressable>
      </View>
    );
  }
  return (
    <>
      <View style={styles.segmented}>
        {(['remove', 'add', 'expand'] as GenerativeOperation[]).map((item) => (
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

      <TextInput
        accessibilityLabel={operation === 'remove' ? 'Removal instructions' : operation === 'expand' ? 'Expansion instructions' : 'Element to add'}
        value={prompt}
        onChangeText={onPromptChange}
        multiline
        placeholder={operation === 'remove' ? 'What should be removed?' : operation === 'expand' ? 'How should the scene continue?' : 'What should be added?'}
        placeholderTextColor={colors.textSecondary}
        style={styles.promptInput}
      />
      <Pressable accessibilityRole="button" style={[styles.primary, (busy || !prompt.trim()) && styles.disabled]} onPress={onGenerate} disabled={busy || !prompt.trim()}>
        {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryText}>{operation === 'remove' ? 'Preview removal' : operation === 'expand' ? 'Preview expansion' : 'Preview addition'}</Text>}
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
  busyLayerId,
  onOpacityChange,
  onOpacityCommit,
  onCommit,
}: {
  stack: LayerStack;
  opacities: Record<string, number>;
  busyLayerId?: string;
  onOpacityChange: (layerId: string, opacity: number) => void;
  onOpacityCommit: (layerId: string, opacity: number) => void;
  onCommit: (stack: LayerStack, label: string) => Promise<boolean>;
}) => (
  <>
    {stack.layers.length === 0 ? <Text style={styles.placeholder}>No edits yet</Text> : null}
    {[...stack.layers].reverse().map((layer, reverseIndex) => {
      const index = stack.layers.length - 1 - reverseIndex;
      const opacity = opacities[layer.id] ?? layer.opacity;
      const busy = Boolean(busyLayerId);
      return (
        <View key={layer.id} style={styles.layerBlock}>
          <View style={[styles.layerRow, !layer.enabled && styles.layerDisabled]}>
            <Pressable accessibilityRole="switch" accessibilityState={{ checked: layer.enabled }} accessibilityLabel={`${layer.enabled ? 'Hide' : 'Show'} ${layer.name}`} style={styles.layerControl} disabled={busy} onPress={() => onCommit(toggleLayer(stack, layer.id), `${layer.enabled ? 'Hide' : 'Show'} ${layer.name}`)}>
              <MaterialCommunityIcons name={layer.enabled ? 'eye' : 'eye-off-outline'} size={20} color={colors.primary} />
            </Pressable>
            <View style={styles.layerInfo}><Text numberOfLines={1} style={styles.layerName}>{layer.name}</Text></View>
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
        </View>
      );
    })}
  </>
);

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
  layerBlock: { paddingBottom: 8, borderBottomColor: colors.separator, borderBottomWidth: StyleSheet.hairlineWidth },
  layerRow: { minHeight: 54, flexDirection: 'row', gap: 2, alignItems: 'center' },
  layerDisabled: { opacity: 0.48 },
  layerControl: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  layerInfo: { flex: 1 },
  layerName: { color: colors.text, fontSize: 13, fontWeight: '700' },
  opacityRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingLeft: 48, paddingRight: 4 },
  opacityValue: { width: 42, color: colors.textSecondary, fontSize: 11, fontVariant: ['tabular-nums'] },
  opacitySlider: { flex: 1, height: 48 },
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
