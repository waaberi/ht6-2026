import { randomUUID } from 'expo-crypto';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PhotoCanvas } from '../components/PhotoCanvas';
import { AdjustmentSheet } from '../components/studio/AdjustmentSheet';
import { LooksPanel } from '../components/studio/LooksPanel';
import { StudioToolRail, type StudioTool } from '../components/studio/StudioToolRail';
import { colors } from '../components/theme';
import { saveGeneratedLayerAsset } from '../data/photoRepository';
import { recordRecommendationFeedback } from '../data/preferences';
import { loadStyleProfiles, type SavedStyleProfile } from '../data/styleRepository';
import { collectiveAdjustmentValues, currentVersion, removeLayer, reorderLayer, setCollectiveAdjustments, toggleLayer } from '../domain/layers';
import type {
  AdjustmentValues,
  CoachAction,
  CoachResponse,
  GenerativeOperation,
  Issue,
  LayerStack,
  Region,
  StyleLayer,
} from '../domain/types';
import { ApiUnavailableError, askCoach, createGenerativePatch } from '../services/api';
import { exportAndShare } from '../services/export';
import { persistPreferences } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

const CENTER_TARGET: Region = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
const UPPER_TARGET: Region = { x: 0.2, y: 0.08, width: 0.6, height: 0.34 };
const LOWER_TARGET: Region = { x: 0.2, y: 0.58, width: 0.6, height: 0.34 };
type ExpansionDirection = 'top' | 'right' | 'bottom' | 'left';

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
): LayerStack => ({
  ...removeStyleLayers(stack),
  layers: [
    ...stack.layers.filter((layer) => layer.type !== 'style'),
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
});

export const StudioScreen = ({ onClose }: { onClose: () => void }) => {
  const {
    selectedPhoto,
    analysis,
    analyzing,
    addAdjustment,
    addLayer,
    commitStack,
    restore,
    runAnalysis,
  } = useExposure();
  const [tool, setTool] = useState<StudioTool>('coach');
  const [message, setMessage] = useState<string>();
  const [coachResponse, setCoachResponse] = useState<CoachResponse>();
  const [coachQuestion, setCoachQuestion] = useState('What is the highest-impact change?');
  const [coachBusy, setCoachBusy] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [draftAdjustments, setDraftAdjustments] = useState<AdjustmentValues>({});
  const [assetBusy, setAssetBusy] = useState(false);
  const [generativeOperation, setGenerativeOperation] = useState<GenerativeOperation>('remove');
  const [generativePrompt, setGenerativePrompt] = useState('Remove the selected distraction and reconstruct the background.');
  const [generativeTarget, setGenerativeTarget] = useState<Region>(CENTER_TARGET);
  const [expansionDirection, setExpansionDirection] = useState<ExpansionDirection>('right');
  const adjustmentCommitRef = useRef(false);
  const [savedLooks, setSavedLooks] = useState<SavedStyleProfile[]>([]);
  const [looksLoading, setLooksLoading] = useState(true);
  const [lookBusy, setLookBusy] = useState(false);
  const [selectedLookId, setSelectedLookId] = useState<string>();
  const [lookStrength, setLookStrength] = useState(0.75);
  const [lookDraftLayerId, setLookDraftLayerId] = useState(() => randomUUID());

  const version = selectedPhoto ? currentVersion(selectedPhoto) : undefined;
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
  const lookChanged = Boolean(selectedLook) && (
    styleLayerCount !== 1
    || appliedLookLayer?.styleProfileId !== selectedLookId
    || Math.abs((appliedLookLayer?.strength ?? -1) - lookStrength) > 0.001
  );
  const selectedIssue = analysis?.issues.find((issue) => issue.id === selectedIssueId) ?? analysis?.issues[0];

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
    setSelectedLookId(appliedLookLayer?.styleProfileId);
    setLookStrength(appliedLookLayer?.strength ?? 0.75);
    setLookDraftLayerId(appliedLookLayer?.id ?? randomUUID());
  }, [appliedLookLayer?.id, appliedLookLayer?.strength, appliedLookLayer?.styleProfileId, version?.id]);

  const previewStack = useMemo<LayerStack | undefined>(() => {
    if (!version) return undefined;
    const adjustedStack = setCollectiveAdjustments(version.stack, draftAdjustments);
    if (tool !== 'looks' || !selectedLook) return adjustedStack;
    return applyStyleLayer(
      adjustedStack,
      selectedLook,
      lookStrength,
      appliedLookLayer?.id ?? lookDraftLayerId,
      appliedLookLayer?.createdAt ?? new Date().toISOString(),
    );
  }, [appliedLookLayer?.createdAt, appliedLookLayer?.id, draftAdjustments, lookDraftLayerId, lookStrength, selectedLook, tool, version]);

  if (!selectedPhoto || !version || !previewStack) {
    return (
      <SafeAreaView style={styles.empty}>
        <Text style={styles.emptyTitle}>No photo selected</Text>
        <Pressable accessibilityRole="button" style={styles.emptyButton} onPress={onClose}><Text style={styles.link}>Back to Library</Text></Pressable>
      </SafeAreaView>
    );
  }

  const commit = async (stack: LayerStack, label: string) => {
    setMessage(undefined);
    try {
      await commitStack(stack, label);
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

  const openGenerativeTool = (operation: GenerativeOperation, target: Region, prompt: string) => {
    setGenerativeOperation(operation);
    setGenerativeTarget(target);
    setGenerativePrompt(prompt);
    setTool('ai');
  };

  const applyIssue = async (issue: Issue) => {
    if (issue.fix?.kind === 'adjustment' && issue.fix.adjustments) {
      setApplying(true);
      try {
        await addAdjustment(issue.fix.adjustments, `Fix: ${issue.title}`);
        await acceptRecommendation(issue);
        setTool('adjust');
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Edit failed.');
      } finally {
        setApplying(false);
      }
    } else if (issue.fix?.kind === 'masked-adjustment' && issue.fix.adjustments) {
      setApplying(true);
      try {
        await addLayer({
          id: randomUUID(), type: 'masked-adjustment', name: `Fix: ${issue.title}`, enabled: true, opacity: 1,
          createdAt: new Date().toISOString(), adjustments: issue.fix.adjustments,
          mask: { type: 'polygon', region: issue.location },
        }, `Fix: ${issue.title}`);
        await acceptRecommendation(issue);
        setTool('layers');
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Edit failed.');
      } finally {
        setApplying(false);
      }
    } else if (issue.fix?.kind === 'transform' && issue.fix.canvasTransform) {
      const changed = await commit({
        ...version.stack,
        canvasTransform: {
          ...version.stack.canvasTransform,
          ...issue.fix.canvasTransform,
          rotationDegrees: version.stack.canvasTransform.rotationDegrees + (issue.fix.canvasTransform.rotationDegrees ?? 0),
        },
      }, `Fix: ${issue.title}`);
      if (changed) {
        await acceptRecommendation(issue);
        setTool('history');
      }
    } else if (issue.fix?.kind === 'retouch' || issue.fix?.kind === 'generative') {
      openGenerativeTool(
        issue.fix.kind === 'retouch' ? 'remove' : 'add',
        issue.location,
        issue.fix.kind === 'retouch'
          ? `Remove ${issue.title.toLowerCase()} and reconstruct the surrounding background.`
          : issue.recommendedAction,
      );
    }
  };

  const analyze = async () => {
    setMessage(undefined);
    try {
      const result = await runAnalysis();
      const firstIssue = result.issues[0];
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

  const applyCoachAction = async (action: CoachAction) => {
    if (!action.requiresConfirmation) return;
    if (action.tool === 'adjust_global' && action.adjustments) {
      await addAdjustment(action.adjustments, action.label);
      setTool('adjust');
    } else if (action.tool === 'adjust_masked' && action.adjustments && action.target) {
      await addLayer({
        id: randomUUID(), type: 'masked-adjustment', name: action.label, enabled: true, opacity: 1,
        createdAt: new Date().toISOString(), adjustments: action.adjustments,
        mask: { type: 'polygon', region: action.target },
      }, action.label);
      setTool('layers');
    } else if ((action.tool === 'crop' || action.tool === 'straighten') && action.canvasTransform) {
      const rotationDelta = action.canvasTransform.rotationDegrees ?? 0;
      await commit({
        ...version.stack,
        canvasTransform: {
          ...version.stack.canvasTransform,
          ...action.canvasTransform,
          rotationDegrees: version.stack.canvasTransform.rotationDegrees + rotationDelta,
        },
      }, action.label);
      setTool('history');
    } else if ((action.tool === 'remove' || action.tool === 'add') && action.target) {
      openGenerativeTool(action.tool, action.target, action.prompt ?? action.reason);
    } else if (action.tool === 'expand' && action.canvasTransform?.expansion) {
      const direction = (['top', 'right', 'bottom', 'left'] as ExpansionDirection[])
        .find((side) => (action.canvasTransform?.expansion?.[side] ?? 0) > 0) ?? 'right';
      setExpansionDirection(direction);
      setGenerativeOperation('expand');
      setGenerativePrompt(action.prompt ?? 'Extend the scene naturally into the new canvas.');
      setTool('ai');
    } else if (action.tool === 'retake') {
      setMessage(action.reason);
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
      const changed = await commit(setCollectiveAdjustments(version.stack, {}), 'Restore adjustments');
      if (!changed) setDraftAdjustments(savedAdjustments);
    } finally {
      adjustmentCommitRef.current = false;
      setApplying(false);
    }
  };

  const chooseLook = (look: SavedStyleProfile) => {
    setSelectedLookId(look.id);
    setLookStrength(appliedLookLayer?.styleProfileId === look.id ? appliedLookLayer.strength : 0.75);
    if (appliedLookLayer?.styleProfileId !== look.id) setLookDraftLayerId(randomUUID());
  };

  const applyLook = async () => {
    if (!selectedLook || !lookChanged) return;
    setLookBusy(true);
    try {
      const changed = await commit(
        applyStyleLayer(
          version.stack,
          selectedLook,
          lookStrength,
          appliedLookLayer?.id ?? lookDraftLayerId,
          appliedLookLayer?.createdAt ?? new Date().toISOString(),
        ),
        `Look: ${selectedLook.name}`,
      );
      if (!changed) {
        setSelectedLookId(appliedLookLayer?.styleProfileId);
        setLookStrength(appliedLookLayer?.strength ?? 0.75);
      }
    } finally {
      setLookBusy(false);
    }
  };

  const restoreLook = async () => {
    if (!appliedLookLayer) {
      setSelectedLookId(undefined);
      setLookStrength(0.75);
      setLookDraftLayerId(randomUUID());
      return;
    }
    setLookBusy(true);
    try {
      const changed = await commit(removeStyleLayers(version.stack), 'Restore look');
      if (changed) {
        setSelectedLookId(undefined);
        setLookStrength(0.75);
        setLookDraftLayerId(randomUUID());
      }
    } finally {
      setLookBusy(false);
    }
  };

  const exportPhoto = async () => {
    setMessage(undefined);
    setExporting(true);
    try {
      await exportAndShare(selectedPhoto, version.stack);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const generateEdit = async () => {
    if (!generativePrompt.trim()) return;
    setMessage(undefined);
    setAssetBusy(true);
    try {
      const result = await createGenerativePatch(
        selectedPhoto,
        version.stack,
        generativeTarget,
        generativePrompt.trim(),
        generativeOperation,
        expansionDirection,
      );
      const patchAssetId = randomUUID();
      const maskAssetId = randomUUID();
      const patchUri = saveGeneratedLayerAsset(patchAssetId, result.patchBase64);
      const maskUri = saveGeneratedLayerAsset(maskAssetId, result.maskBase64);
      const label = generativeOperation === 'remove'
        ? `Removed ${selectedIssue?.title.toLowerCase() ?? 'selection'}`
        : generativeOperation === 'expand'
          ? `Expanded ${expansionDirection}`
          : `Added ${generativePrompt.trim().slice(0, 42)}`;
      const generatedLayer = {
        id: randomUUID(), type: 'generative-patch', name: label, enabled: true, opacity: 1,
        createdAt: new Date().toISOString(), patchAssetId, patchUri, maskAssetId, maskUri,
        target: result.target, prompt: generativePrompt.trim(),
        canvasSpace: true,
        canvasExpansion: result.expansion ?? version.stack.canvasTransform.expansion ?? { top: 0, right: 0, bottom: 0, left: 0 },
        provenance: { model: result.model, sourceVersionId: result.sourceVersionId, driftScore: result.driftScore },
      } as const;
      if (generativeOperation === 'expand') {
        if (!result.expansion) throw new Error('The expansion result did not include canvas geometry.');
        await commit({
          ...version.stack,
          canvasTransform: { ...version.stack.canvasTransform, expansion: result.expansion },
          layers: [...version.stack.layers, generatedLayer],
        }, label);
      } else {
        await addLayer(generatedLayer, label);
      }
      await acceptRecommendation(selectedIssue);
      setTool('layers');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'AI edit failed.');
    } finally {
      setAssetBusy(false);
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
          <MaterialCommunityIcons name="arrow-left" size={26} color={colors.ink} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Edit</Text>
        </View>
        <Pressable accessibilityRole="button" style={styles.exportButton} onPress={exportPhoto} disabled={exporting}>
          {exporting ? <ActivityIndicator size="small" color={colors.limeInk} /> : <Text style={styles.exportButtonText}>Export</Text>}
        </Pressable>
      </View>

      <View style={styles.canvas}>
        <PhotoCanvas
          uri={selectedPhoto.originalUri}
          stack={previewStack}
          analysis={analysis}
          target={tool === 'ai' && generativeOperation !== 'expand' ? generativeTarget : undefined}
          showIssues={tool === 'coach'}
        />
      </View>

      <View style={styles.panel}>
        {message ? <Text accessibilityRole="alert" style={styles.message}>{message}</Text> : null}
        <ScrollView
          key={tool}
          contentContainerStyle={styles.panelContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {tool === 'coach' ? (
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
              onQuestionChange={setCoachQuestion}
              onAsk={ask}
              onApplyIssue={applyIssue}
              onApplyAction={applyCoachAction}
            />
          ) : null}

          {tool === 'adjust' ? (
            <AdjustmentSheet
              values={draftAdjustments}
              onChange={(key, value) => setDraftAdjustments((current) => ({ ...current, [key]: value }))}
              onCommit={commitAdjustment}
              onResetControl={(key) => void commitAdjustment(key, 0)}
              onRestore={() => void restoreAdjustments()}
              busy={applying}
            />
          ) : null}

          {tool === 'looks' ? (
            <LooksPanel
              looks={savedLooks}
              selectedLookId={selectedLookId}
              strength={lookStrength}
              loading={looksLoading}
              busy={lookBusy}
              canApply={lookChanged}
              canRestore={Boolean(appliedLookLayer || selectedLookId)}
              onSelect={chooseLook}
              onStrengthChange={setLookStrength}
              onApply={() => void applyLook()}
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
              onOperationChange={(operation) => {
                setGenerativeOperation(operation);
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
              }}
              onGenerate={generateEdit}
              onExpansionDirectionChange={setExpansionDirection}
            />
          ) : null}

          {tool === 'layers' ? (
            <LayersPanel
              stack={version.stack}
              onCommit={commit}
            />
          ) : null}

          {tool === 'history' ? (
            <HistoryPanel photo={selectedPhoto} onRestore={restore} />
          ) : null}
        </ScrollView>
        <StudioToolRail active={tool} onChange={setTool} />
      </View>
    </SafeAreaView>
  );
};

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
  onQuestionChange: (value: string) => void;
  onAsk: () => void;
  onApplyIssue: (issue: Issue) => void;
  onApplyAction: (action: CoachAction) => void;
}) => {
  if (!analysis) {
    return (
      <View style={styles.centerAction}>
        <Pressable accessibilityRole="button" style={styles.primary} onPress={onAnalyze} disabled={analyzing}>
          {analyzing ? <ActivityIndicator color={colors.limeInk} /> : <Text style={styles.primaryText}>Analyze photo</Text>}
        </Pressable>
      </View>
    );
  }
  const fixable = selectedIssue?.fix && !['crop', 'retake'].includes(selectedIssue.fix.kind);
  return (
    <>
      <Text style={styles.summary}>{response?.headline ?? analysis.summary}</Text>
      {response?.reason ? <Text style={styles.body}>{response.reason}</Text> : null}

      {analysis.issues.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {analysis.issues.slice(0, 6).map((issue) => (
            <Pressable
              key={issue.id}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedIssue?.id === issue.id }}
              onPress={() => onSelectIssue(issue)}
              style={[styles.chip, selectedIssue?.id === issue.id && styles.chipActive]}
            >
              <Text style={[styles.chipText, selectedIssue?.id === issue.id && styles.chipTextActive]}>{issue.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {selectedIssue ? (
        <View style={styles.focusedFinding}>
          <View style={styles.findingHeading}>
            <Text style={styles.findingTitle}>{selectedIssue.title}</Text>
            <Text style={styles.confidence}>{Math.round(selectedIssue.confidence * 100)}%</Text>
          </View>
          <Text numberOfLines={3} style={styles.body}>{selectedIssue.explanation}</Text>
          {fixable ? (
            <Pressable accessibilityRole="button" style={styles.inlineAction} onPress={() => onApplyIssue(selectedIssue)} disabled={applying}>
              <Text style={styles.inlineActionText}>{selectedIssue.fix?.kind === 'retouch' || selectedIssue.fix?.kind === 'generative' ? 'Review fix' : 'Apply fix'}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {analysis.cameraRecommendations.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Capture advice</Text>
          {analysis.cameraRecommendations.map((advice, index) => (
            <View key={`${advice.setting}-${index}`} style={styles.adviceRow}>
              <Text style={styles.adviceSetting}>{advice.setting.replace('-', ' ')}</Text>
              <View style={styles.adviceBody}>
                {advice.value ? <Text style={styles.adviceValue}>{advice.value}</Text> : null}
                <Text numberOfLines={2} style={styles.caption}>{advice.explanation}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {response?.evidence.length ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Evidence</Text>
          {response.evidence.map((item) => <Text key={item.path} style={styles.caption}>• {item.meaning}</Text>)}
        </View>
      ) : null}

      {response?.actions.map((action) => (
        <View key={action.id} style={styles.actionRow}>
          <View style={styles.actionCopy}><Text style={styles.findingTitle}>{action.label}</Text><Text numberOfLines={2} style={styles.caption}>{action.reason}</Text></View>
          <Pressable accessibilityRole="button" style={styles.smallPrimary} onPress={() => onApplyAction(action)}>
            <Text style={styles.smallPrimaryText}>{action.tool === 'remove' || action.tool === 'add' || action.tool === 'expand' ? 'Review' : 'Apply'}</Text>
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
          placeholderTextColor={colors.muted}
          style={styles.askInput}
        />
        <Pressable accessibilityRole="button" style={styles.askButton} onPress={onAsk} disabled={coachBusy || !question.trim()}>
          {coachBusy ? <ActivityIndicator color={colors.limeInk} /> : <Text style={styles.askButtonText}>Ask</Text>}
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
  onOperationChange,
  onPromptChange,
  onTargetChange,
  onGenerate,
  onExpansionDirectionChange,
}: {
  operation: GenerativeOperation;
  prompt: string;
  target: Region;
  issues: Issue[];
  busy: boolean;
  expansionDirection: ExpansionDirection;
  onOperationChange: (operation: GenerativeOperation) => void;
  onPromptChange: (value: string) => void;
  onTargetChange: (target: Region, issueId?: string) => void;
  onGenerate: () => void;
  onExpansionDirectionChange: (direction: ExpansionDirection) => void;
}) => {
  const selected = (candidate: Region) => JSON.stringify(candidate) === JSON.stringify(target);
  return (
    <>
      <View style={styles.segmented}>
        {(['remove', 'add', 'expand'] as GenerativeOperation[]).map((item) => (
          <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: operation === item }} style={[styles.segment, operation === item && styles.segmentActive]} onPress={() => onOperationChange(item)}>
            <Text style={[styles.segmentText, operation === item && styles.segmentTextActive]}>{item[0].toUpperCase() + item.slice(1)}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>{operation === 'expand' ? 'Expand edge' : 'Select area'}</Text>
      {operation === 'expand' ? (
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
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {issues.slice(0, 3).map((issue) => (
            <Pressable key={issue.id} accessibilityRole="button" style={[styles.chip, selected(issue.location) && styles.chipActive]} onPress={() => onTargetChange(issue.location, issue.id)}>
              <Text style={[styles.chipText, selected(issue.location) && styles.chipTextActive]}>{issue.title}</Text>
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
        placeholderTextColor={colors.muted}
        style={styles.promptInput}
      />
      <Pressable accessibilityRole="button" style={[styles.primary, (busy || !prompt.trim()) && styles.disabled]} onPress={onGenerate} disabled={busy || !prompt.trim()}>
        {busy ? <ActivityIndicator color={colors.limeInk} /> : <Text style={styles.primaryText}>{operation === 'remove' ? 'Generate removal' : operation === 'expand' ? 'Expand canvas' : 'Generate addition'}</Text>}
      </Pressable>
    </>
  );
};

const LayersPanel = ({ stack, onCommit }: { stack: LayerStack; onCommit: (stack: LayerStack, label: string) => Promise<boolean> }) => (
  <>
    {stack.layers.length === 0 ? <Text style={styles.placeholder}>No edits yet</Text> : null}
    {[...stack.layers].reverse().map((layer, reverseIndex) => {
      const index = stack.layers.length - 1 - reverseIndex;
      return (
        <View key={layer.id} style={[styles.layerRow, !layer.enabled && styles.layerDisabled]}>
          <Pressable accessibilityRole="switch" accessibilityState={{ checked: layer.enabled }} accessibilityLabel={`${layer.enabled ? 'Hide' : 'Show'} ${layer.name}`} style={styles.layerControl} onPress={() => onCommit(toggleLayer(stack, layer.id), `${layer.enabled ? 'Hide' : 'Show'} ${layer.name}`)}>
            <MaterialCommunityIcons name={layer.enabled ? 'eye' : 'eye-off-outline'} size={20} color={colors.lime} />
          </Pressable>
          <View style={styles.layerInfo}><Text numberOfLines={1} style={styles.layerName}>{layer.name}</Text><Text style={styles.caption}>{Math.round(layer.opacity * 100)}%</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Move ${layer.name} up`} style={styles.layerControl} onPress={() => onCommit(reorderLayer(stack, layer.id, 1), `Move ${layer.name}`)} disabled={index === stack.layers.length - 1}><MaterialCommunityIcons name="arrow-up" size={20} color={colors.ink} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Move ${layer.name} down`} style={styles.layerControl} onPress={() => onCommit(reorderLayer(stack, layer.id, -1), `Move ${layer.name}`)} disabled={index === 0}><MaterialCommunityIcons name="arrow-down" size={20} color={colors.ink} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${layer.name}`} style={styles.layerControl} onPress={() => onCommit(removeLayer(stack, layer.id), `Remove ${layer.name}`)}><MaterialCommunityIcons name="close" size={22} color={colors.danger} /></Pressable>
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
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: { minHeight: 58, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, backgroundColor: colors.panel },
  headerButton: { width: 88, height: 48, alignItems: 'flex-start', justifyContent: 'center', paddingLeft: 12 },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { color: colors.ink, fontWeight: '800', fontSize: 16 },
  exportButton: { width: 88, minHeight: 48, borderRadius: 8, backgroundColor: colors.lime, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  exportButtonText: { color: colors.limeInk, fontSize: 12, fontWeight: '800' },
  canvas: { flex: 1, minHeight: 190 },
  panel: { maxHeight: '50%', minHeight: 214, backgroundColor: colors.panel },
  panelContent: { padding: 16, paddingBottom: 20 },
  message: { color: colors.ink, backgroundColor: colors.panelRaised, fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingVertical: 10 },
  centerAction: { minHeight: 100, justifyContent: 'center' },
  primary: { backgroundColor: colors.lime, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, paddingHorizontal: 16 },
  primaryText: { color: colors.limeInk, fontWeight: '800', fontSize: 13 },
  summary: { color: colors.ink, fontSize: 18, fontWeight: '800', lineHeight: 23 },
  body: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  caption: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  chips: { gap: 8, paddingVertical: 12 },
  chip: { minHeight: 40, maxWidth: 180, borderRadius: 20, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line },
  chipActive: { backgroundColor: colors.lime, borderColor: colors.lime },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  chipTextActive: { color: colors.limeInk },
  directionGrid: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  directionButton: { flex: 1, minHeight: 48, borderRadius: 8, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  focusedFinding: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  findingHeading: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  findingTitle: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '800' },
  confidence: { color: colors.muted, fontSize: 12 },
  inlineAction: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginTop: 4 },
  inlineActionText: { color: colors.lime, fontSize: 12, fontWeight: '800' },
  section: { marginTop: 16 },
  sectionTitle: { color: colors.ink, fontSize: 13, fontWeight: '800', marginBottom: 8 },
  adviceRow: { minHeight: 54, flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 7, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
  adviceSetting: { width: 88, color: colors.muted, fontSize: 12, fontWeight: '700' },
  adviceBody: { flex: 1 },
  adviceValue: { color: colors.ink, fontSize: 13, fontWeight: '700', marginBottom: 2 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  actionCopy: { flex: 1 },
  smallPrimary: { minWidth: 68, minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.lime, borderRadius: 8 },
  smallPrimaryText: { color: colors.limeInk, fontSize: 12, fontWeight: '800' },
  askRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  askInput: { flex: 1, minHeight: 48, color: colors.ink, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: 12, fontSize: 13 },
  askButton: { minWidth: 64, minHeight: 48, borderRadius: 8, backgroundColor: colors.lime, alignItems: 'center', justifyContent: 'center' },
  askButtonText: { color: colors.limeInk, fontSize: 12, fontWeight: '800' },
  segmented: { flexDirection: 'row', minHeight: 48, borderRadius: 9, padding: 3, backgroundColor: colors.canvas, marginBottom: 16 },
  segment: { flex: 1, minHeight: 42, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  segmentActive: { backgroundColor: colors.panelRaised },
  segmentText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: colors.ink },
  promptInput: { minHeight: 76, color: colors.ink, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: 12, textAlignVertical: 'top', marginBottom: 12, fontSize: 13 },
  disabled: { opacity: 0.45 },
  placeholder: { color: colors.muted, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  layerRow: { minHeight: 58, flexDirection: 'row', gap: 2, alignItems: 'center', borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
  layerDisabled: { opacity: 0.48 },
  layerControl: { width: 44, height: 48, alignItems: 'center', justifyContent: 'center' },
  layerInfo: { flex: 1 },
  layerName: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  historyRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
  timelineDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.muted },
  timelineDotActive: { borderColor: colors.lime, backgroundColor: colors.lime },
  restoreButton: { minWidth: 64, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  restore: { color: colors.lime, fontSize: 11, fontWeight: '800' },
  current: { color: colors.muted, fontSize: 10, fontWeight: '800', paddingHorizontal: 8 },
  empty: { flex: 1, backgroundColor: colors.canvas, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  emptyButton: { minHeight: 48, justifyContent: 'center' },
  link: { color: colors.lime, fontSize: 13, fontWeight: '700' },
});
