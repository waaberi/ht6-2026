export type LibraryChatRole = 'user' | 'assistant';

export type LibraryChatMessage = {
  id: string;
  role: LibraryChatRole;
  content: string;
  createdAt: string;
  attachedPhotoIds: string[];
};

export type LibraryChatResponse = {
  answer: string;
  model: string;
};
