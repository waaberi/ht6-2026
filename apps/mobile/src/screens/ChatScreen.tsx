import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EditedPhotoThumbnail } from "../components/EditedPhotoThumbnail";
import {
  colors,
  layout,
  radii,
  spacing,
  typography,
} from "../components/theme";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import type { LibraryChatMessage } from "../domain/libraryChat";
import type { PhotoRecord } from "../domain/types";
import { useExposure } from "../state/ExposureContext";

const MAX_ATTACHMENTS = 4;
const STARTERS = [
  "What lens should I pick up next?",
  "What camera do I use most?",
  "What patterns do you see in my settings?",
];

export const ChatScreen = ({
  messages,
  busy,
  error,
  onSend,
}: {
  messages: LibraryChatMessage[];
  busy: boolean;
  error?: string;
  onSend: (question: string, attachedPhotoIds: string[]) => Promise<boolean>;
}) => {
  const { photos } = useExposure();
  const [draft, setDraft] = useState("");
  const [attachedPhotoIds, setAttachedPhotoIds] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const photoById = useMemo(
    () => new Map(photos.map((photo) => [photo.id, photo])),
    [photos],
  );
  const attachedPhotos = attachedPhotoIds
    .map((id) => photoById.get(id))
    .filter((photo): photo is PhotoRecord => Boolean(photo));
  const canSend = draft.trim().length > 0 && !busy;

  useEffect(() => {
    const valid = new Set(photos.map((photo) => photo.id));
    setAttachedPhotoIds((current) => current.filter((id) => valid.has(id)));
  }, [photos]);

  useEffect(() => {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollToEnd({ animated: messages.length > 0 }),
    );
  }, [busy, messages]);

  const send = async () => {
    const question = draft.trim();
    if (!question || busy) return;
    const attachmentSnapshot = [...attachedPhotoIds];
    setDraft("");
    const sent = await onSend(question, attachmentSnapshot);
    if (sent) {
      setAttachedPhotoIds([]);
    } else {
      setDraft(question);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <ScreenHeader title="Chat" detail="Gemini" />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.messages,
          messages.length === 0 && styles.emptyMessages,
        ]}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: false })
        }
        showsVerticalScrollIndicator={false}
        style={styles.messageScroller}
      >
        {messages.length === 0 ? (
          <View style={styles.welcome}>
            <View style={styles.welcomeIcon}>
              <Ionicons name="sparkles" size={26} color={colors.onPrimary} />
            </View>
            <Text style={styles.welcomeTitle}>Ask about your photography</Text>
            <Text style={styles.welcomeBody}>
              Gemini can use metadata from your library. Attach photos when you
              want visual feedback or style-aware gear advice.
            </Text>
            <View style={styles.starters}>
              {STARTERS.map((starter) => (
                <Pressable
                  key={starter}
                  accessibilityRole="button"
                  onPress={() => setDraft(starter)}
                  style={({ pressed }) => [
                    styles.starter,
                    pressed && styles.controlPressed,
                  ]}
                >
                  <Text style={styles.starterText}>{starter}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          messages.map((message) => (
            <ChatBubble
              key={message.id}
              message={message}
              photoById={photoById}
            />
          ))
        )}
        {busy ? (
          <View
            accessibilityLabel="Gemini is responding"
            style={[styles.bubble, styles.assistantBubble, styles.typingBubble]}
          >
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.typingText}>
              Thinking about your library...
            </Text>
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </ScrollView>

      <View style={styles.composerWrap}>
        {attachedPhotos.length > 0 ? (
          <ScrollView
            horizontal
            contentContainerStyle={styles.attachmentStrip}
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
          >
            {attachedPhotos.map((photo) => (
              <View key={photo.id} style={styles.attachmentChip}>
                <EditedPhotoThumbnail
                  photo={photo}
                  style={styles.attachmentImage}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${photo.originalName}`}
                  onPress={() =>
                    setAttachedPhotoIds((current) =>
                      current.filter((id) => id !== photo.id),
                    )
                  }
                  style={styles.removeAttachment}
                >
                  <Ionicons name="close" size={15} color={colors.onPrimary} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.composer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach photos from Library"
            disabled={busy}
            onPress={() => setPickerOpen(true)}
            style={({ pressed }) => [
              styles.attachButton,
              pressed && styles.controlPressed,
              busy && styles.disabled,
            ]}
          >
            <Ionicons name="images-outline" size={23} color={colors.text} />
            {attachedPhotoIds.length ? (
              <Text style={styles.attachCount}>{attachedPhotoIds.length}</Text>
            ) : null}
          </Pressable>
          <TextInput
            accessibilityLabel="Message Gemini"
            editable={!busy}
            maxLength={500}
            multiline
            onChangeText={setDraft}
            placeholder="Ask about your photos or gear"
            placeholderTextColor={colors.textSecondary}
            style={styles.input}
            value={draft}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !canSend, busy }}
            disabled={!canSend}
            onPress={() => void send()}
            style={({ pressed }) => [
              styles.sendButton,
              pressed && styles.primaryPressed,
              !canSend && styles.disabled,
            ]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Ionicons name="arrow-up" size={22} color={colors.onPrimary} />
            )}
          </Pressable>
        </View>
        <Text style={styles.sessionNote}>
          Session only - this chat is not saved to your files or account.
        </Text>
      </View>

      <PhotoAttachmentPicker
        photos={photos}
        selectedIds={attachedPhotoIds}
        visible={pickerOpen}
        onChange={setAttachedPhotoIds}
        onClose={() => setPickerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
};

const ChatBubble = ({
  message,
  photoById,
}: {
  message: LibraryChatMessage;
  photoById: Map<string, PhotoRecord>;
}) => {
  const user = message.role === "user";
  const attached = message.attachedPhotoIds
    .map((id) => photoById.get(id))
    .filter((photo): photo is PhotoRecord => Boolean(photo));
  return (
    <View
      accessibilityLabel={`${user ? "You" : "Gemini"}: ${message.content}`}
      style={[styles.bubble, user ? styles.userBubble : styles.assistantBubble]}
    >
      {attached.length > 0 ? (
        <View style={styles.messageAttachments}>
          {attached.map((photo) => (
            <EditedPhotoThumbnail
              key={photo.id}
              photo={photo}
              style={styles.messageImage}
            />
          ))}
        </View>
      ) : null}
      <Text style={[styles.messageText, user && styles.userMessageText]}>
        {message.content}
      </Text>
    </View>
  );
};

const PhotoAttachmentPicker = ({
  photos,
  selectedIds,
  visible,
  onChange,
  onClose,
}: {
  photos: PhotoRecord[];
  selectedIds: string[];
  visible: boolean;
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) => {
  const { width } = useWindowDimensions();
  const columns = width >= 700 ? 5 : width >= 480 ? 4 : 3;
  const tileSize = Math.floor(
    (width - spacing.md * 2 - spacing.sm * (columns - 1)) / columns,
  );
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((item) => item !== id));
    } else if (selectedIds.length < MAX_ATTACHMENTS) {
      onChange([...selectedIds, id]);
    }
  };
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={styles.pickerScreen} edges={["top", "bottom"]}>
        <View style={styles.pickerHeader}>
          <View>
            <Text accessibilityRole="header" style={styles.pickerTitle}>
              Attach photos
            </Text>
            <Text style={styles.pickerDetail}>
              {selectedIds.length} of {MAX_ATTACHMENTS} selected
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={styles.doneButton}
          >
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
        {photos.length > 0 ? (
          <FlatList
            data={photos}
            numColumns={columns}
            columnWrapperStyle={styles.pickerRow}
            contentContainerStyle={styles.pickerGrid}
            extraData={selectedIds}
            key={columns}
            keyExtractor={(photo) => photo.id}
            renderItem={({ item }) => {
              const selected = selectedIds.includes(item.id);
              const disabled =
                !selected && selectedIds.length >= MAX_ATTACHMENTS;
              return (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={item.originalName}
                  accessibilityState={{ checked: selected, disabled }}
                  disabled={disabled}
                  onPress={() => toggle(item.id)}
                  style={({ pressed }) => [
                    styles.pickerTile,
                    { width: tileSize, height: tileSize },
                    selected && styles.pickerTileSelected,
                    pressed && styles.tilePressed,
                    disabled && styles.disabled,
                  ]}
                >
                  <EditedPhotoThumbnail
                    photo={item}
                    style={StyleSheet.absoluteFillObject}
                  />
                  <View
                    style={[
                      styles.pickerCheck,
                      selected && styles.pickerCheckSelected,
                    ]}
                  >
                    {selected ? (
                      <Ionicons
                        name="checkmark"
                        size={18}
                        color={colors.onPrimary}
                      />
                    ) : null}
                  </View>
                </Pressable>
              );
            }}
          />
        ) : (
          <View style={styles.noPhotos}>
            <Ionicons
              name="images-outline"
              size={36}
              color={colors.textSecondary}
            />
            <Text style={styles.noPhotosText}>
              Your Library has no photos to attach yet.
            </Text>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  messageScroller: { flex: 1 },
  messages: {
    flexGrow: 1,
    width: "100%",
    maxWidth: layout.readingMaxWidth,
    alignSelf: "center",
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.md,
    gap: spacing.base,
  },
  emptyMessages: { justifyContent: "center" },
  welcome: { alignItems: "center", paddingVertical: spacing.xl },
  welcomeIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    marginBottom: spacing.md,
  },
  welcomeTitle: {
    color: colors.text,
    ...typography.section,
    fontWeight: "800",
    textAlign: "center",
  },
  welcomeBody: {
    color: colors.textSecondary,
    ...typography.body,
    textAlign: "center",
    marginTop: spacing.sm,
    maxWidth: 520,
  },
  starters: { width: "100%", gap: spacing.sm, marginTop: spacing.lg },
  starter: {
    minHeight: layout.minTouchTarget,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.controlSurface,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  starterText: { color: colors.text, ...typography.label, fontWeight: "700" },
  bubble: {
    maxWidth: "88%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.base,
    borderRadius: radii.lg,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: colors.primary,
    borderBottomRightRadius: radii.sm,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderBottomLeftRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  typingBubble: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  typingText: { color: colors.textSecondary, ...typography.label },
  messageText: { color: colors.text, ...typography.body },
  userMessageText: { color: colors.onPrimary },
  messageAttachments: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  messageImage: { width: 72, height: 58, borderRadius: radii.sm },
  error: {
    color: colors.error,
    ...typography.label,
    alignSelf: "center",
    textAlign: "center",
    maxWidth: layout.formMaxWidth,
  },
  composerWrap: {
    width: "100%",
    maxWidth: layout.readingMaxWidth,
    alignSelf: "center",
    paddingHorizontal: spacing.base,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    backgroundColor: colors.background,
  },
  attachmentStrip: { gap: spacing.xs, paddingBottom: spacing.xs },
  attachmentChip: {
    width: 62,
    height: 54,
    borderRadius: radii.sm,
    overflow: "visible",
  },
  attachmentImage: { width: 62, height: 54, borderRadius: radii.sm },
  removeAttachment: {
    position: "absolute",
    right: -5,
    top: -5,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.background,
  },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: spacing.xs },
  attachButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.controlSurface,
  },
  attachCount: {
    position: "absolute",
    right: 3,
    top: 2,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    color: colors.onPrimary,
    backgroundColor: colors.primary,
    ...typography.caption,
    fontSize: 10,
    lineHeight: 17,
    fontWeight: "800",
    textAlign: "center",
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 112,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.controlSurface,
    color: colors.text,
    ...typography.body,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === "ios" ? 12 : 8,
    textAlignVertical: "center",
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  sessionNote: {
    color: colors.textSecondary,
    ...typography.caption,
    textAlign: "center",
    marginTop: spacing.xs,
  },
  pickerScreen: { flex: 1, backgroundColor: colors.background },
  pickerHeader: {
    minHeight: 72,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  pickerTitle: { color: colors.text, ...typography.title, fontWeight: "800" },
  pickerDetail: {
    color: colors.textSecondary,
    ...typography.caption,
    marginTop: spacing.xxs,
  },
  doneButton: {
    minWidth: 72,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    backgroundColor: colors.primary,
  },
  doneText: { color: colors.onPrimary, ...typography.label, fontWeight: "800" },
  pickerGrid: { padding: spacing.md, gap: spacing.sm },
  pickerRow: { gap: spacing.sm },
  pickerTile: {
    borderRadius: radii.sm,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "transparent",
  },
  pickerTileSelected: { borderColor: colors.primary },
  pickerCheck: {
    position: "absolute",
    right: spacing.xs,
    top: spacing.xs,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: colors.white,
    backgroundColor: colors.overlay,
    alignItems: "center",
    justifyContent: "center",
  },
  pickerCheckSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  noPhotos: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.xl,
  },
  noPhotosText: {
    color: colors.textSecondary,
    ...typography.body,
    textAlign: "center",
  },
  controlPressed: { backgroundColor: colors.controlPressed },
  primaryPressed: { backgroundColor: colors.primaryPressed },
  tilePressed: { opacity: 0.76 },
  disabled: { opacity: 0.42 },
});
