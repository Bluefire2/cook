/**
 * The Library screen's dialogs. At most one sheet is open, and each sheet
 * carries the data its workflow needs, so a move into a new collection keeps
 * its recipe id and a retried create reuses the collection it already made.
 *
 * `token` changes whenever a sheet opens or closes. An async submit captures
 * it at the start; completions from an older token are ignored, so a late
 * result cannot close or overwrite a sheet the user opened since.
 */
export type LibrarySheet =
  | { kind: 'closed' }
  | { kind: 'add' }
  | { kind: 'deleteRecipe'; recipeId: string }
  | { kind: 'move'; recipeId: string; error?: string }
  | {
      kind: 'create';
      /** Set when the new collection is the destination of a move. */
      moveRecipeId?: string;
      name: string;
      /** A collection an earlier attempt already created; retries reuse it. */
      created?: { id: string; name: string };
      error?: string;
    }
  | { kind: 'rename'; collectionId: string; name: string; error?: string }
  | { kind: 'deleteCollection'; collectionId: string; error?: string }
  | { kind: 'leave'; collectionId: string; busy: boolean; error?: string }
  | { kind: 'share' }
  | { kind: 'inviteConfirm' };

export type LibraryFlow = { token: number; sheet: LibrarySheet };

export type LibraryFlowAction =
  | { type: 'openAdd' }
  | { type: 'openDeleteRecipe'; recipeId: string }
  | { type: 'openMove'; recipeId: string }
  /** From the move sheet the new collection becomes the move's destination. */
  | { type: 'startCreate' }
  | { type: 'openRename'; collectionId: string; name: string }
  | { type: 'openDeleteCollection'; collectionId: string }
  | { type: 'openLeave'; collectionId: string }
  | { type: 'openShare' }
  | { type: 'openInviteConfirm' }
  | { type: 'setName'; name: string }
  | { type: 'submitting'; token: number }
  | { type: 'created'; token: number; created: { id: string; name: string } }
  | { type: 'failed'; token: number; error: string }
  | { type: 'close' }
  | { type: 'closeInviteConfirm' };

export const initialLibraryFlow: LibraryFlow = { token: 0, sheet: { kind: 'closed' } };

function open(state: LibraryFlow, sheet: LibrarySheet): LibraryFlow {
  return { token: state.token + 1, sheet };
}

export function libraryFlowReducer(
  state: LibraryFlow,
  action: LibraryFlowAction,
): LibraryFlow {
  const { sheet } = state;
  switch (action.type) {
    case 'openAdd':
      return open(state, { kind: 'add' });
    case 'openDeleteRecipe':
      return open(state, { kind: 'deleteRecipe', recipeId: action.recipeId });
    case 'openMove':
      return open(state, { kind: 'move', recipeId: action.recipeId });
    case 'startCreate':
      return open(state, {
        kind: 'create',
        name: '',
        ...(sheet.kind === 'move' ? { moveRecipeId: sheet.recipeId } : {}),
      });
    case 'openRename':
      return open(state, {
        kind: 'rename',
        collectionId: action.collectionId,
        name: action.name,
      });
    case 'openDeleteCollection':
      return open(state, { kind: 'deleteCollection', collectionId: action.collectionId });
    case 'openLeave':
      return open(state, { kind: 'leave', collectionId: action.collectionId, busy: false });
    case 'openShare':
      return open(state, { kind: 'share' });
    case 'openInviteConfirm':
      return open(state, { kind: 'inviteConfirm' });
    case 'setName':
      if (sheet.kind !== 'create' && sheet.kind !== 'rename') {
        return state;
      }
      return { ...state, sheet: { ...sheet, name: action.name } };
    case 'submitting':
      if (action.token !== state.token) {
        return state;
      }
      switch (sheet.kind) {
        case 'leave':
          return { ...state, sheet: { ...sheet, busy: true, error: undefined } };
        case 'move':
        case 'create':
        case 'rename':
        case 'deleteCollection':
          return { ...state, sheet: { ...sheet, error: undefined } };
        default:
          return state;
      }
    case 'created':
      if (action.token !== state.token || sheet.kind !== 'create') {
        return state;
      }
      return { ...state, sheet: { ...sheet, created: action.created } };
    case 'failed':
      if (action.token !== state.token) {
        return state;
      }
      switch (sheet.kind) {
        case 'leave':
          return { ...state, sheet: { ...sheet, busy: false, error: action.error } };
        case 'move':
        case 'create':
        case 'rename':
        case 'deleteCollection':
          return { ...state, sheet: { ...sheet, error: action.error } };
        default:
          return state;
      }
    case 'close':
      return open(state, { kind: 'closed' });
    case 'closeInviteConfirm':
      return sheet.kind === 'inviteConfirm' ? open(state, { kind: 'closed' }) : state;
  }
}

/** The error a sheet shows, if any. */
export function sheetError(sheet: LibrarySheet): string | undefined {
  return 'error' in sheet ? sheet.error : undefined;
}
