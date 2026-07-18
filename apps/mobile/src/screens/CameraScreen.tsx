import { type CameraType, CameraView, type FlashMode, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import React, { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../components/theme';
import { useExposure } from '../state/ExposureContext';

export const CameraScreen = ({ onOpenStudio }: { onOpenStudio: () => void }) => {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { ingest } = useExposure();

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await work();
      onOpenStudio();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The photo could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  const capture = () =>
    run(async () => {
      if (!camera.current || !ready) throw new Error('Camera is still starting.');
      const picture = await camera.current.takePictureAsync({ quality: 1, exif: true, skipProcessing: false });
      await ingest({
        uri: picture.uri,
        name: `Exposure-${Date.now()}.${picture.format}`,
        mimeType: picture.format === 'png' ? 'image/png' : 'image/jpeg',
        source: 'camera',
        width: picture.width,
        height: picture.height,
        exif: picture.exif ?? {},
      });
    });

  const importLibrary = () =>
    run(async () => {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        allowsMultipleSelection: false,
        quality: 1,
        exif: true,
      });
      if (result.canceled) throw new Error('Import cancelled.');
      const asset = result.assets[0];
      await ingest({
        uri: asset.uri,
        name: asset.fileName ?? `Imported-${Date.now()}.jpg`,
        mimeType: asset.mimeType,
        source: 'library',
        width: asset.width,
        height: asset.height,
        exif: asset.exif,
      });
    });

  const importDocument = () =>
    run(async () => {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/jpeg', 'image/png', 'image/heic', 'image/heif'],
        copyToCacheDirectory: true,
      });
      if (result.canceled) throw new Error('Import cancelled.');
      const asset = result.assets[0];
      const documentUri = decodeURIComponent(asset.uri);
      const removableStorage = /externalstorage\.documents.*\/document\/(?!primary:)/i.test(documentUri);
      await ingest({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
        source: removableStorage ? 'usb' : 'document',
      });
    });

  if (!permission) return <View style={styles.black} />;
  if (!permission.granted) {
    return (
      <View style={styles.permission}>
        <Text style={styles.wordmark}>EXPOSURE</Text>
        <Text style={styles.permissionTitle}>Your camera is the starting point.</Text>
        <Text style={styles.permissionBody}>Exposure needs camera access to capture photos. Existing photos can still be imported.</Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>Allow camera</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={importLibrary}>
          <Text style={styles.secondaryButtonText}>Choose a photo instead</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.black}>
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        mode="picture"
        onCameraReady={() => setReady(true)}
        onMountError={(event) => setError(event.message)}
      />
      <View pointerEvents="none" style={styles.scrim} />
      <View pointerEvents="none" style={styles.grid}>
        <View style={[styles.verticalLine, { left: '33.33%' }]} />
        <View style={[styles.verticalLine, { left: '66.66%' }]} />
        <View style={[styles.horizontalLine, { top: '33.33%' }]} />
        <View style={[styles.horizontalLine, { top: '66.66%' }]} />
      </View>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.wordmark}>EXPOSURE</Text>
          <Text style={styles.mode}>PHOTO COACH</Text>
        </View>
        <View style={styles.topActions}>
          <Pressable style={styles.roundButton} onPress={() => setFlash((value) => (value === 'off' ? 'auto' : value === 'auto' ? 'on' : 'off'))}>
            <Text style={styles.roundButtonText}>{flash === 'off' ? 'ϟ̸' : flash === 'auto' ? 'ϟA' : 'ϟ'}</Text>
          </Pressable>
          <Pressable style={styles.roundButton} onPress={() => setFacing((value) => (value === 'back' ? 'front' : 'back'))}>
            <Text style={styles.roundButtonText}>↻</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.bottomPanel}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.hint}>Frame with intent. Exposure will handle the evidence.</Text>
        <View style={styles.captureRow}>
          <Pressable style={styles.importButton} onPress={importLibrary} disabled={busy}>
            <Text style={styles.importGlyph}>▦</Text>
            <Text style={styles.importLabel}>Library</Text>
          </Pressable>
          <Pressable style={[styles.shutter, (!ready || busy) && styles.disabled]} onPress={capture} disabled={!ready || busy}>
            {busy ? <ActivityIndicator color={colors.limeInk} /> : <View style={styles.shutterCore} />}
          </Pressable>
          <Pressable style={styles.importButton} onPress={importDocument} disabled={busy}>
            <Text style={styles.importGlyph}>＋</Text>
            <Text style={styles.importLabel}>Files / USB</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  black: { flex: 1, backgroundColor: colors.canvas },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.08)' },
  grid: { position: 'absolute', left: 0, right: 0, top: 100, bottom: 180 },
  verticalLine: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.35)' },
  horizontalLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.35)' },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 24, paddingHorizontal: 20, paddingBottom: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(0,0,0,0.36)' },
  wordmark: { color: colors.ink, fontSize: 21, fontWeight: '900', letterSpacing: 4 },
  mode: { color: colors.lime, fontSize: 9, fontWeight: '800', letterSpacing: 2.4, marginTop: 4 },
  topActions: { flexDirection: 'row', gap: 10 },
  roundButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(20,20,18,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
  roundButtonText: { color: colors.white, fontSize: 17, fontWeight: '700' },
  bottomPanel: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 18, backgroundColor: 'rgba(10,10,9,0.88)' },
  hint: { color: colors.ink, textAlign: 'center', fontSize: 12, letterSpacing: 0.2, marginBottom: 12 },
  error: { color: colors.danger, textAlign: 'center', fontSize: 12, marginBottom: 8 },
  captureRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  importButton: { width: 84, alignItems: 'center', gap: 3, paddingVertical: 8 },
  importGlyph: { color: colors.ink, fontSize: 24 },
  importLabel: { color: colors.muted, fontSize: 10 },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 3, borderColor: colors.ink, padding: 5, backgroundColor: 'rgba(0,0,0,0.2)', alignItems: 'center', justifyContent: 'center' },
  shutterCore: { width: '100%', height: '100%', borderRadius: 32, backgroundColor: colors.lime },
  disabled: { opacity: 0.5 },
  permission: { flex: 1, paddingHorizontal: 28, backgroundColor: colors.canvas, justifyContent: 'center' },
  permissionTitle: { color: colors.ink, fontSize: 32, lineHeight: 37, fontWeight: '800', marginTop: 38 },
  permissionBody: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 14, marginBottom: 28 },
  primaryButton: { backgroundColor: colors.lime, paddingVertical: 16, alignItems: 'center', borderRadius: 4 },
  primaryButtonText: { color: colors.limeInk, fontWeight: '800', fontSize: 15 },
  secondaryButton: { paddingVertical: 16, alignItems: 'center' },
  secondaryButtonText: { color: colors.ink, fontWeight: '700', fontSize: 14 },
});
