import * as vscode from 'vscode';

/**
 * Provides basic auto-complete for Xojo code in .xojo edit files.
 * Covers keywords, control structures, access modifiers, and common built-in types.
 */
export class XojoCompletionProvider implements vscode.CompletionItemProvider {

  private static readonly KEYWORDS: string[] = [
    // Control flow
    'If', 'Then', 'Else', 'ElseIf', 'End If',
    'Select', 'Case', 'End Select',
    'For', 'Each', 'Next', 'To', 'Step',
    'While', 'Wend', 'End While',
    'Do', 'Loop', 'Until',
    'Try', 'Catch', 'Finally', 'End Try',
    'Return', 'Exit',
    // Declaration
    'Sub', 'Function', 'End Sub', 'End Function',
    'Dim', 'Var', 'Const', 'As',
    'Class', 'End Class',
    'Module', 'End Module',
    'Interface', 'End Interface',
    'Structure', 'End Structure',
    'Enum', 'End Enum',
    'Namespace', 'End Namespace',
    // Access modifiers
    'Public', 'Private', 'Protected', 'Shared', 'Static',
    'Virtual', 'Override', 'Implements',
    'Extends',
    // Object keywords
    'New', 'Nil', 'Me', 'Self', 'Super',
    'IsA', 'Is', 'Not', 'And', 'Or', 'Xor',
    'Mod',
    // Event / delegate
    'Raises', 'RaiseEvent',
    'AddHandler', 'RemoveHandler',
    'WeakAddressOf', 'AddressOf',
    // Exception
    'Raise',
    // Literals
    'True', 'False',
    // Pragma
    '#If', '#ElseIf', '#Else', '#End If',
    '#Pragma',
    // Misc
    'In', 'Break', 'Continue',
  ];

  private static readonly TYPES: string[] = [
    // Primitives
    'String', 'Boolean',
    'Integer', 'Int8', 'Int16', 'Int32', 'Int64',
    'UInt8', 'UInt16', 'UInt32', 'UInt64',
    'Single', 'Double', 'Currency',
    'Byte', 'Short',
    // Special
    'Variant', 'Object', 'Auto',
    // Common built-in classes
    'Dictionary', 'Pair',
    'Color', 'Date', 'DateTime',
    'Xojo.Core.Dictionary',
    // Web types
    'WebSession', 'WebView', 'WebContainer', 'WebDialog',
    'WebButton', 'WebLabel', 'WebTextField', 'WebTextArea',
    'WebListBox', 'WebComboBox', 'WebCheckBox', 'WebRadioButton',
    'WebTimer', 'WebFile',
    // Desktop types
    'Window', 'Dialog', 'Control', 'ContainerControl',
    'PushButton', 'Label', 'TextField', 'TextArea',
    'ListBox', 'PopupMenu', 'CheckBox', 'RadioButton',
    'Timer', 'Picture', 'Graphics',
    // Other common
    'FolderItem', 'TextInputStream', 'TextOutputStream',
    'BinaryStream', 'MemoryBlock',
    'Exception', 'RuntimeException', 'NilObjectException',
    'OutOfBoundsException', 'TypeMismatchException',
    'RegEx', 'RegExMatch',
  ];

  provideCompletionItems(
    _doc: vscode.TextDocument,
    _pos: vscode.Position,
    _token: vscode.CancellationToken,
    _ctx: vscode.CompletionContext
  ): vscode.CompletionItem[] {
    const keywords = XojoCompletionProvider.KEYWORDS.map(k => {
      const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
      item.detail = 'Xojo keyword';
      return item;
    });

    const types = XojoCompletionProvider.TYPES.map(t => {
      const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.Class);
      item.detail = 'Xojo type';
      return item;
    });

    return [...keywords, ...types];
  }
}
