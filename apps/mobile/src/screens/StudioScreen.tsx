import { randomUUID } from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { PhotoCanvas } from '../components/PhotoCanvas';
import { colors } from '../components/theme';
import { saveGeneratedLayerAsset, saveImportedLayerAsset } from '../data/photoRepository';
import { recordRecommendationFeedback } from '../data/preferences';
import { currentVersion, removeLayer, reorderLayer, toggleLayer } from '../domain/layers';
import type { Issue, LayerStack } from '../domain/types';
import { identityCanvasTransform } from '../domain/types';
import { ApiUnavailableError, askCoach, createGenerativePatch } from '../services/api';
import { exportAndShare } from '../services/export';
import { persistPreferences } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

type StudioTab = 'coach' | 'edit' | 'layers' | 'history';

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
  const [tab, setTab] = useState<StudioTab>('coach');
  const [message, setMessage] = useState<string>();
  const [coachAnswer, setCoachAnswer] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [assetBusy, setAssetBusy] = useState(false);
  const [generativePrompt, setGenerativePrompt] = useState('Remove the distraction while reconstructing the surrounding background.');
  const [generativeTarget, setGenerativeTarget] = useState({ x: 0.35, y: 0.35, width: 0.3, height: 0.3 });

  if (!selectedPhoto) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Choose a photo from Library.</Text>
        <Pressable onPress={onClose}><Text style={styles.link}>Back</Text></Pressable>
      </View>
    );
  }

  const version = currentVersion(selectedPhoto);
  const commit = async (stack: LayerStack, label: string) => {
    setMessage(undefined);
    try {
      await commitStack(stack, label);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Edit failed.');
    }
  };

  const applyIssue = async (issue: Issue) => {
    const preferences = await recordRecommendationFeedback(issue.id, true);
    void persistPreferences(preferences).catch(() => undefined);
    if (issue.fix?.kind === 'adjustment' && issue.fix.adjustments) {
      await addAdjustment(issue.fix.adjustments, `Fix: ${issue.title}`);
      setTab('layers');
    } else if (issue.fix?.kind === 'masked-adjustment' && issue.fix.adjustments) {
      await addLayer({
        id: randomUUID(), type: 'masked-adjustment', name: `Fix: ${issue.title}`, enabled: true, opacity: 1,
        createdAt: new Date().toISOString(), adjustments: issue.fix.adjustments,
        mask: { type: 'polygon', region: issue.location },
      }, `Fix: ${issue.title}`);
      setTab('layers');
    } else if (issue.fix?.kind === 'crop') {
      await commit({
        ...version.stack,
        canvasTransform: { ...version.stack.canvasTransform, crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 } },
      }, `Fix: ${issue.title}`);
      setTab('history');
    } else if (issue.fix?.kind === 'transform' && issue.fix.canvasTransform) {
      await commit({
        ...version.stack,
        canvasTransform: {
          ...version.stack.canvasTransform,
          ...issue.fix.canvasTransform,
          rotationDegrees: version.stack.canvasTransform.rotationDegrees + (issue.fix.canvasTransform.rotationDegrees ?? 0),
        },
      }, `Fix: ${issue.title}`);
      setTab('history');
    } else if (issue.fix?.kind === 'retouch' || issue.fix?.kind === 'generative') {
      setGenerativeTarget(issue.location);
      setGenerativePrompt(issue.fix.kind === 'retouch' ? `Remove ${issue.title.toLowerCase()} and reconstruct the surrounding background.` : issue.recommendedAction);
      setTab('edit');
    }
  };

  const rejectIssue = async (issue: Issue) => {
    const preferences = await recordRecommendationFeedback(issue.id, false);
    void persistPreferences(preferences).catch(() => undefined);
    setMessage(`Saved feedback: “${issue.title}” is not useful for this photograph.`);
  };

  const analyze = async () => {
    setMessage(undefined);
    try {
      await runAnalysis();
    } catch (error) {
      setMessage(error instanceof ApiUnavailableError ? error.message : error instanceof Error ? error.message : 'Analysis failed.');
    }
  };

  const ask = async () => {
    if (!analysis) return;
    setMessage(undefined);
    try {
      const response = await askCoach(analysis, 'What is the single highest-impact change I should make?');
      setCoachAnswer(response.answer);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Coach is unavailable.');
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

  const importOverlay = async () => {
    setMessage(undefined);
    setAssetBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 1 });
      if (result.canceled) return;
      const source = result.assets[0];
      const assetId = randomUUID();
      const uri = await saveImportedLayerAsset(assetId, source.uri, source.mimeType);
      await addLayer({
        id: randomUUID(), type: 'image', name: source.fileName ?? 'Image overlay', enabled: true, opacity: 0.8,
        createdAt: new Date().toISOString(), assetId, uri, transform: identityCanvasTransform(), blendMode: 'normal',
      }, 'Add image overlay');
      setTab('layers');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Image layer import failed.');
    } finally {
      setAssetBusy(false);
    }
  };

  const generatePatch = async () => {
    if (!generativePrompt.trim()) return;
    setMessage(undefined);
    setAssetBusy(true);
    try {
      const result = await createGenerativePatch(selectedPhoto, version.stack, generativeTarget, generativePrompt.trim());
      const patchAssetId = randomUUID();
      const maskAssetId = randomUUID();
      const patchUri = saveGeneratedLayerAsset(patchAssetId, result.patchBase64);
      const maskUri = saveGeneratedLayerAsset(maskAssetId, result.maskBase64);
      await addLayer({
        id: randomUUID(), type: 'generative-patch', name: 'Generative patch', enabled: true, opacity: 1,
        createdAt: new Date().toISOString(), patchAssetId, patchUri, maskAssetId, maskUri,
        target: result.target, prompt: generativePrompt.trim(),
        provenance: { model: result.model, sourceVersionId: result.sourceVersionId, driftScore: result.driftScore },
      }, 'Add generative patch');
      setTab('layers');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Generative patch failed.');
    } finally {
      setAssetBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.headerButton} onPress={onClose}><Text style={styles.headerButtonText}>‹</Text></Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>STUDIO</Text>
          <Text numberOfLines={1} style={styles.headerMeta}>{selectedPhoto.originalName} · v{selectedPhoto.versions.length}</Text>
        </View>
        <View style={styles.headerActions}>
          <Text style={styles.originalSafe}>ORIGINAL SAFE</Text>
          <Pressable style={styles.exportButton} onPress={exportPhoto} disabled={exporting}>
            {exporting ? <ActivityIndicator size="small" color={colors.limeInk} /> : <Text style={styles.exportButtonText}>EXPORT</Text>}
          </Pressable>
        </View>
      </View>
      <View style={styles.canvas}>
        <PhotoCanvas uri={selectedPhoto.originalUri} stack={version.stack} analysis={analysis} />
      </View>
      <View style={styles.panel}>
        <View style={styles.tabs}>
          {(['coach', 'edit', 'layers', 'history'] as StudioTab[]).map((item) => (
            <Pressable key={item} style={[styles.tab, tab === item && styles.tabActive]} onPress={() => setTab(item)}>
              <Text style={[styles.tabText, tab === item && styles.tabTextActive]}>{item.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        <ScrollView contentContainerStyle={styles.panelContent} showsVerticalScrollIndicator={false}>
          {tab === 'coach' ? (
            <>
              {!analysis ? (
                <View style={styles.callout}>
                  <Text style={styles.calloutEyebrow}>MEASURE FIRST</Text>
                  <Text style={styles.calloutTitle}>Turn pixels into photographic evidence.</Text>
                  <Text style={styles.calloutBody}>Exposure checks light, clipping, color, sharpness and composition before asking Gemini about intent.</Text>
                  <Pressable style={styles.primary} onPress={analyze} disabled={analyzing}>
                    {analyzing ? <ActivityIndicator color={colors.limeInk} /> : <Text style={styles.primaryText}>Analyze this version</Text>}
                  </Pressable>
                </View>
              ) : (
                <>
                  <View style={styles.summaryRow}>
                    <View style={styles.score}><Text style={styles.scoreValue}>{Math.max(0, 100 - Math.round(analysis.issues.reduce((sum, issue) => sum + issue.severity * 12, 0)))}</Text><Text style={styles.scoreLabel}>FRAME SCORE</Text></View>
                    <Text style={styles.summary}>{analysis.summary}</Text>
                  </View>
                  {analysis.issues.map((issue) => (
                    <View key={issue.id} style={styles.issueCard}>
                      <View style={styles.issueHeading}>
                        <Text style={styles.issueCategory}>{issue.category.toUpperCase()}</Text>
                        <Text style={styles.issueConfidence}>{Math.round(issue.confidence * 100)}%</Text>
                      </View>
                      <Text style={styles.issueTitle}>{issue.title}</Text>
                      <Text style={styles.issueBody}>{issue.explanation}</Text>
                      <Text style={styles.issueAction}>{issue.recommendedAction}</Text>
                      {issue.fix && issue.fix.kind !== 'retake' ? (
                        <Pressable style={styles.fix} onPress={() => applyIssue(issue)}><Text style={styles.fixText}>{issue.fix.kind === 'crop' ? 'Apply reversible crop' : issue.fix.kind === 'transform' ? 'Apply reversible transform' : issue.fix.kind === 'retouch' || issue.fix.kind === 'generative' ? 'Prepare generative fix' : 'Apply as layer'}</Text></Pressable>
                      ) : null}
                      <Pressable style={styles.reject} onPress={() => rejectIssue(issue)}><Text style={styles.rejectText}>Not useful for this photo</Text></Pressable>
                    </View>
                  ))}
                  <Pressable style={styles.coachButton} onPress={ask}><Text style={styles.coachButtonText}>Ask for the highest-impact change</Text></Pressable>
                  {coachAnswer ? <Text style={styles.coachAnswer}>{coachAnswer}</Text> : null}
                </>
              )}
            </>
          ) : null}
          {tab === 'edit' ? (
            <>
              <Text style={styles.sectionTitle}>Quick adjustments</Text>
              <View style={styles.actionGrid}>
                <EditButton label="Lift exposure" value="+0.25 EV" onPress={() => addAdjustment({ exposure: 0.25 }, 'Lift exposure')} />
                <EditButton label="Lower exposure" value="−0.25 EV" onPress={() => addAdjustment({ exposure: -0.25 }, 'Lower exposure')} />
                <EditButton label="Add contrast" value="+12" onPress={() => addAdjustment({ contrast: 0.12 }, 'Add contrast')} />
                <EditButton label="Warm image" value="+8" onPress={() => addAdjustment({ temperature: 0.08 }, 'Warm image')} />
                <EditButton label="More color" value="+10" onPress={() => addAdjustment({ saturation: 0.1 }, 'Increase saturation')} />
                <EditButton label="Sharpen" value="+15" onPress={() => addAdjustment({ sharpening: 0.15 }, 'Sharpen')} />
              </View>
              <Text style={styles.sectionTitle}>Canvas transforms</Text>
              <View style={styles.actionGrid}>
                <EditButton label="Crop edges" value="5%" onPress={() => commit({ ...version.stack, canvasTransform: { ...version.stack.canvasTransform, crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 } } }, 'Crop edges')} />
                <EditButton label="Straighten" value="+1°" onPress={() => commit({ ...version.stack, canvasTransform: { ...version.stack.canvasTransform, rotationDegrees: version.stack.canvasTransform.rotationDegrees + 1 } }, 'Straighten')} />
              </View>
              <Text style={styles.safetyNote}>Each tap commits a separate version. The source file is never rewritten.</Text>
              <Text style={styles.sectionTitle}>Image layer</Text>
              <Pressable style={styles.secondaryAction} onPress={importOverlay} disabled={assetBusy}>
                <Text style={styles.secondaryActionText}>Import image as independent overlay</Text>
              </Pressable>
              <Text style={styles.sectionTitle}>Generative patch</Text>
              <Text style={styles.generatorHint}>The target is the highest-priority issue box, or the center region until analysis runs. The service rejects unrelated drift.</Text>
              <TextInput
                value={generativePrompt}
                onChangeText={setGenerativePrompt}
                multiline
                placeholder="Describe only the intended local change"
                placeholderTextColor={colors.muted}
                style={styles.promptInput}
              />
              <Pressable style={[styles.primary, assetBusy && styles.busyButton]} onPress={generatePatch} disabled={assetBusy || !generativePrompt.trim()}>
                {assetBusy ? <ActivityIndicator color={colors.limeInk} /> : <Text style={styles.primaryText}>Generate localized patch</Text>}
              </Pressable>
            </>
          ) : null}
          {tab === 'layers' ? (
            <>
              <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>Layer stack</Text><Text style={styles.sectionMeta}>{version.stack.layers.length} layers</Text></View>
              {version.stack.layers.length === 0 ? <Text style={styles.placeholder}>The original has no edits. Apply a fix or adjustment to add a layer.</Text> : null}
              {[...version.stack.layers].reverse().map((layer, reverseIndex) => {
                const index = version.stack.layers.length - 1 - reverseIndex;
                return (
                  <View key={layer.id} style={[styles.layerRow, !layer.enabled && styles.layerDisabled]}>
                    <Pressable style={[styles.visibility, layer.enabled && styles.visibilityOn]} onPress={() => commit(toggleLayer(version.stack, layer.id), `${layer.enabled ? 'Hide' : 'Show'} ${layer.name}`)}><Text style={styles.visibilityText}>{layer.enabled ? '●' : '○'}</Text></Pressable>
                    <View style={styles.layerInfo}><Text numberOfLines={1} style={styles.layerName}>{layer.name}</Text><Text style={styles.layerType}>{layer.type} · {Math.round(layer.opacity * 100)}%</Text></View>
                    <Pressable onPress={() => commit(reorderLayer(version.stack, layer.id, 1), `Move ${layer.name}`)} disabled={index === version.stack.layers.length - 1}><Text style={styles.layerAction}>↑</Text></Pressable>
                    <Pressable onPress={() => commit(reorderLayer(version.stack, layer.id, -1), `Move ${layer.name}`)} disabled={index === 0}><Text style={styles.layerAction}>↓</Text></Pressable>
                    <Pressable onPress={() => commit(removeLayer(version.stack, layer.id), `Remove ${layer.name}`)}><Text style={[styles.layerAction, { color: colors.danger }]}>×</Text></Pressable>
                  </View>
                );
              })}
            </>
          ) : null}
          {tab === 'history' ? (
            <>
              <Text style={styles.sectionTitle}>Version history</Text>
              {[...selectedPhoto.versions].reverse().map((item, index) => (
                <View key={item.id} style={styles.historyRow}>
                  <View style={[styles.timelineDot, item.id === selectedPhoto.currentVersionId && styles.timelineDotActive]} />
                  <View style={styles.layerInfo}>
                    <Text style={styles.layerName}>{item.label}</Text>
                    <Text style={styles.layerType}>{new Date(item.createdAt).toLocaleString()} · {item.stack.layers.length} layers</Text>
                  </View>
                  {index !== 0 ? <Pressable onPress={() => restore(item.id)}><Text style={styles.restore}>RESTORE</Text></Pressable> : <Text style={styles.current}>CURRENT</Text>}
                </View>
              ))}
            </>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
};

const EditButton = ({ label, value, onPress }: { label: string; value: string; onPress: () => void }) => (
  <Pressable style={styles.editButton} onPress={onPress}>
    <Text style={styles.editValue}>{value}</Text><Text style={styles.editLabel}>{label}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: { height: 62, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, backgroundColor: colors.panel },
  headerButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  headerButtonText: { color: colors.ink, fontSize: 34, lineHeight: 36 },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { color: colors.ink, fontWeight: '900', letterSpacing: 2.4, fontSize: 13 },
  headerMeta: { color: colors.muted, fontSize: 9, marginTop: 2, maxWidth: 190 },
  headerActions: { width: 74, alignItems: 'stretch', gap: 3 },
  originalSafe: { color: colors.lime, fontSize: 6, fontWeight: '900', letterSpacing: 0.5, textAlign: 'center' },
  exportButton: { minHeight: 28, borderRadius: 3, backgroundColor: colors.lime, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  exportButtonText: { color: colors.limeInk, fontSize: 8, fontWeight: '900', letterSpacing: 0.8 },
  canvas: { flex: 1, minHeight: 210 },
  panel: { height: '48%', minHeight: 330, backgroundColor: colors.panel },
  tabs: { height: 48, flexDirection: 'row', borderBottomColor: colors.line, borderBottomWidth: 1 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.lime },
  tabText: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  tabTextActive: { color: colors.ink },
  panelContent: { padding: 16, paddingBottom: 36 },
  message: { color: colors.danger, fontSize: 11, paddingHorizontal: 16, paddingTop: 10 },
  callout: { backgroundColor: colors.panelRaised, padding: 18, borderLeftWidth: 3, borderLeftColor: colors.lime },
  calloutEyebrow: { color: colors.lime, fontSize: 9, fontWeight: '900', letterSpacing: 1.7 },
  calloutTitle: { color: colors.ink, fontWeight: '800', fontSize: 21, lineHeight: 25, marginTop: 7 },
  calloutBody: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  primary: { backgroundColor: colors.lime, marginTop: 16, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 3 },
  primaryText: { color: colors.limeInk, fontWeight: '900', fontSize: 12, letterSpacing: 0.4 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 12 },
  score: { width: 72, height: 72, borderRadius: 36, borderWidth: 3, borderColor: colors.lime, alignItems: 'center', justifyContent: 'center' },
  scoreValue: { color: colors.ink, fontWeight: '900', fontSize: 24 },
  scoreLabel: { color: colors.muted, fontSize: 6, letterSpacing: 0.8 },
  summary: { flex: 1, color: colors.ink, lineHeight: 18, fontSize: 12 },
  issueCard: { backgroundColor: colors.panelRaised, borderWidth: 1, borderColor: colors.line, padding: 14, marginTop: 9, borderRadius: 4 },
  issueHeading: { flexDirection: 'row', justifyContent: 'space-between' },
  issueCategory: { color: colors.lime, fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  issueConfidence: { color: colors.muted, fontSize: 9 },
  issueTitle: { color: colors.ink, fontSize: 15, fontWeight: '800', marginTop: 7 },
  issueBody: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  issueAction: { color: colors.ink, fontSize: 11, lineHeight: 16, marginTop: 8 },
  fix: { alignSelf: 'flex-start', backgroundColor: colors.lime, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10, borderRadius: 2 },
  fixText: { color: colors.limeInk, fontSize: 10, fontWeight: '900' },
  reject: { alignSelf: 'flex-start', paddingVertical: 8, marginTop: 2 },
  rejectText: { color: colors.muted, fontSize: 9, fontWeight: '700' },
  coachButton: { borderColor: colors.line, borderWidth: 1, alignItems: 'center', padding: 12, marginTop: 12 },
  coachButtonText: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  coachAnswer: { color: colors.ink, backgroundColor: colors.panelRaised, padding: 14, lineHeight: 18, fontSize: 12 },
  sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: colors.ink, fontWeight: '900', fontSize: 15, marginBottom: 10 },
  sectionMeta: { color: colors.muted, fontSize: 10 },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  editButton: { width: '31%', minHeight: 72, backgroundColor: colors.panelRaised, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', padding: 8, borderRadius: 3 },
  editValue: { color: colors.lime, fontSize: 14, fontWeight: '900' },
  editLabel: { color: colors.muted, fontSize: 9, textAlign: 'center', marginTop: 5 },
  safetyNote: { color: colors.muted, fontSize: 10, fontStyle: 'italic', lineHeight: 15 },
  secondaryAction: { minHeight: 44, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  secondaryActionText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  generatorHint: { color: colors.muted, fontSize: 10, lineHeight: 15, marginBottom: 8 },
  promptInput: { minHeight: 76, color: colors.ink, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.line, padding: 11, textAlignVertical: 'top' },
  busyButton: { opacity: 0.55 },
  placeholder: { color: colors.muted, fontSize: 12, lineHeight: 18, paddingVertical: 20 },
  layerRow: { minHeight: 58, flexDirection: 'row', gap: 8, alignItems: 'center', borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
  layerDisabled: { opacity: 0.5 },
  visibility: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  visibilityOn: { borderColor: colors.lime },
  visibilityText: { color: colors.lime, fontSize: 11 },
  layerInfo: { flex: 1 },
  layerName: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  layerType: { color: colors.muted, fontSize: 9, marginTop: 3, textTransform: 'uppercase' },
  layerAction: { color: colors.ink, fontSize: 18, padding: 5 },
  historyRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
  timelineDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.muted },
  timelineDotActive: { borderColor: colors.lime, backgroundColor: colors.lime },
  restore: { color: colors.lime, fontSize: 9, fontWeight: '900' },
  current: { color: colors.muted, fontSize: 8, fontWeight: '900' },
  empty: { flex: 1, backgroundColor: colors.canvas, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.ink },
  link: { color: colors.lime, marginTop: 12 },
});
