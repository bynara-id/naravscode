export default function (pi) {
  const bridgeUrl = process.env.PI_VSCODE_BRIDGE_URL;
  const bridgeToken = process.env.PI_VSCODE_BRIDGE_TOKEN;

  if (!bridgeUrl || !bridgeToken) return;

  const callBridge = async (method, params = {}) => {
    const response = await fetch(`${bridgeUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pi-vscode-authorization": bridgeToken,
      },
      body: JSON.stringify({ method, params }),
    });

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = payload?.error || `Bridge request failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload?.result;
  };

  const emptyObjectSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  const positionSchema = {
    type: "object",
    properties: {
      line: { type: "number", description: "Zero-based line number" },
      character: { type: "number", description: "Zero-based character offset" },
    },
    required: ["line", "character"],
    additionalProperties: false,
  };

  const selectionSchema = {
    type: "object",
    properties: {
      start: positionSchema,
      end: positionSchema,
    },
    required: ["start", "end"],
    additionalProperties: false,
  };

  const filePathSchema = {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute or workspace-relative file path" },
    },
    required: ["filePath"],
    additionalProperties: false,
  };

  const diagnosticsSchema = {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Optional absolute or workspace-relative file path",
      },
    },
    additionalProperties: false,
  };

  const openFileSchema = {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute or workspace-relative file path" },
      preview: { type: "boolean", description: "Open in preview mode" },
      preserveFocus: {
        type: "boolean",
        description: "Keep focus in the current editor if possible",
      },
      selection: selectionSchema,
    },
    required: ["filePath"],
    additionalProperties: false,
  };

  const positionLookupSchema = {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute or workspace-relative file path" },
      position: positionSchema,
    },
    required: ["filePath", "position"],
    additionalProperties: false,
  };

  const codeActionsSchema = {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute or workspace-relative file path" },
      selection: selectionSchema,
      start: positionSchema,
      end: positionSchema,
    },
    required: ["filePath"],
    additionalProperties: false,
  };

  const notificationsSchema = {
    type: "object",
    properties: {
      since: { type: "number", description: "Only return notifications after this timestamp" },
      limit: { type: "number", description: "Maximum number of notifications to return" },
    },
    additionalProperties: false,
  };

  const executeCodeActionSchema = {
    type: "object",
    properties: {
      actionId: { type: "string", description: "Action id returned by vscode_get_code_actions" },
    },
    required: ["actionId"],
    additionalProperties: false,
  };

  const workspaceEditSchema = {
    type: "object",
    properties: {
      edits: {
        type: "array",
        description: "List of text replacements to apply through VS Code",
        items: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Absolute or workspace-relative file path",
            },
            range: selectionSchema,
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["filePath", "range", "newText"],
          additionalProperties: false,
        },
      },
    },
    required: ["edits"],
    additionalProperties: false,
  };

  const jsonResult = async (method, params) => ({
    content: [{ type: "text", text: JSON.stringify(await callBridge(method, params)) }],
    details: {},
  });

  const tools = [
    {
      name: "vscode_get_editor_state",
      label: "VS Code Editor State",
      description:
        "Get the active editor, current selection, cached latest selection, workspace folders, and open editors from VS Code.",
      promptSnippet: "Read current VS Code editor state, selection, and open editors.",
      promptGuidelines: [
        "Use VS Code bridge tools when the user asks about their current editor state, selection, diagnostics, symbols, references, or editor actions.",
        "If vscode_get_code_actions returns an action id, use vscode_execute_code_action to apply that exact quick fix.",
        "Use vscode_apply_workspace_edit when you need VS Code to update open buffers with explicit range-based edits.",
      ],
      parameters: emptyObjectSchema,
      execute: async () => jsonResult("getEditorState"),
    },
    {
      name: "vscode_get_selection",
      label: "VS Code Current Selection",
      description:
        "Get the current active VS Code editor selection, including text, file path, and coordinates.",
      promptSnippet: "Read the exact active VS Code selection and selected text.",
      parameters: emptyObjectSchema,
      execute: async () => jsonResult("getCurrentSelection"),
    },
    {
      name: "vscode_get_latest_selection",
      label: "VS Code Latest Selection",
      description:
        "Get the latest cached selection observed by the VS Code extension, even if focus moved away.",
      parameters: emptyObjectSchema,
      execute: async () => jsonResult("getLatestSelection"),
    },
    {
      name: "vscode_get_diagnostics",
      label: "VS Code Diagnostics",
      description:
        "Get VS Code diagnostics (LSP, lint, or type errors) for a file or the full workspace.",
      promptSnippet: "Read current VS Code diagnostics for a file or the workspace.",
      parameters: diagnosticsSchema,
      execute: async (_toolCallId, params) => jsonResult("getDiagnostics", params),
    },
    {
      name: "vscode_get_open_editors",
      label: "VS Code Open Editors",
      description:
        "List open editors and tabs in VS Code, including which one is active and whether files are dirty.",
      parameters: emptyObjectSchema,
      execute: async () => jsonResult("getOpenEditors"),
    },
    {
      name: "vscode_get_workspace_folders",
      label: "VS Code Workspace Folders",
      description: "List VS Code workspace folders and metadata for the current window.",
      parameters: emptyObjectSchema,
      execute: async () => jsonResult("getWorkspaceFolders"),
    },
    {
      name: "vscode_open_file",
      label: "VS Code Open File",
      description: "Open a file in VS Code and optionally reveal a selection range.",
      parameters: openFileSchema,
      execute: async (_toolCallId, params) => jsonResult("openFile", params),
    },
    {
      name: "vscode_check_document_dirty",
      label: "VS Code Dirty State",
      description: "Check whether a file is open in VS Code and whether it has unsaved changes.",
      parameters: filePathSchema,
      execute: async (_toolCallId, params) => jsonResult("checkDocumentDirty", params),
    },
    {
      name: "vscode_save_document",
      label: "VS Code Save Document",
      description: "Save a document through VS Code so editor buffers and disk stay synchronized.",
      parameters: filePathSchema,
      execute: async (_toolCallId, params) => jsonResult("saveDocument", params),
    },
    {
      name: "vscode_get_document_symbols",
      label: "VS Code Document Symbols",
      description: "Get outline symbols for a file from the active language server.",
      parameters: filePathSchema,
      execute: async (_toolCallId, params) => jsonResult("getDocumentSymbols", params),
    },
    {
      name: "vscode_get_references",
      label: "VS Code References",
      description: "Get symbol references from VS Code at a given file position.",
      parameters: positionLookupSchema,
      execute: async (_toolCallId, params) => jsonResult("getReferences", params),
    },
    {
      name: "vscode_get_code_actions",
      label: "VS Code Code Actions",
      description:
        "Get code actions or quick fixes available for a file range or selection from VS Code providers.",
      parameters: codeActionsSchema,
      execute: async (_toolCallId, params) => jsonResult("getCodeActions", params),
    },
    {
      name: "vscode_execute_code_action",
      label: "VS Code Execute Code Action",
      description: "Execute a previously listed code action by id.",
      parameters: executeCodeActionSchema,
      execute: async (_toolCallId, params) => jsonResult("executeCodeAction", params),
    },
    {
      name: "vscode_apply_workspace_edit",
      label: "VS Code Apply Workspace Edit",
      description:
        "Apply explicit range-based text replacements through VS Code so open editor buffers stay in sync.",
      parameters: workspaceEditSchema,
      execute: async (_toolCallId, params) => jsonResult("applyWorkspaceEdit", params),
    },
    {
      name: "vscode_get_notifications",
      label: "VS Code Notifications",
      description:
        "Get recent bridge notifications like selection changes, diagnostics changes, active editor changes, and save/dirty events.",
      parameters: notificationsSchema,
      execute: async (_toolCallId, params) => jsonResult("getNotifications", params),
    },
    {
      name: "vscode_clear_notifications",
      label: "VS Code Clear Notifications",
      description: "Clear the buffered VS Code bridge notification queue.",
      parameters: emptyObjectSchema,
      execute: async () => jsonResult("clearNotifications"),
    },
  ];

  for (const tool of tools) pi.registerTool(tool);
}
