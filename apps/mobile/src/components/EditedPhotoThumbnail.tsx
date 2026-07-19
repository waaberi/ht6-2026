import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { currentVersion } from '../domain/layers';
import type { PhotoRecord } from '../domain/types';
import { PhotoCanvas } from './PhotoCanvas';

export const EditedPhotoThumbnail = ({
  photo,
  style,
}: {
  photo: PhotoRecord;
  style?: StyleProp<ViewStyle>;
}) => (
  <View accessible={false} pointerEvents="none" style={[styles.frame, style]}>
    <PhotoCanvas
      contentFit="cover"
      hiddenFromAccessibility
      showIssues={false}
      stack={currentVersion(photo).stack}
      uri={photo.thumbnailUri}
    />
  </View>
);

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
});
