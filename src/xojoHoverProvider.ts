import * as vscode from 'vscode';

export interface DocEntry {
  description: string;
  url: string;
}

/** Exported so extension.ts can use it for cursor-based panel help. */
export const BUILTIN_DOCS: Record<string, DocEntry> = {
    // Core types
    'String': {
      description: 'A sequence of Unicode characters.',
      url: 'https://documentation.xojo.com/api/language/string.html'
    },
    'Integer': {
      description: 'A 32-bit signed integer (alias for Int32).',
      url: 'https://documentation.xojo.com/api/language/integer.html'
    },
    'Boolean': {
      description: 'A True/False value.',
      url: 'https://documentation.xojo.com/api/language/boolean.html'
    },
    'Double': {
      description: 'A 64-bit IEEE 754 floating-point number.',
      url: 'https://documentation.xojo.com/api/language/double.html'
    },
    'Single': {
      description: 'A 32-bit IEEE 754 floating-point number.',
      url: 'https://documentation.xojo.com/api/language/single.html'
    },
    'Variant': {
      description: 'A variable that can hold any data type.',
      url: 'https://documentation.xojo.com/api/language/variant.html'
    },
    'Dictionary': {
      description: 'An associative collection of key/value pairs.',
      url: 'https://documentation.xojo.com/api/data_types/dictionary.html'
    },
    'Color': {
      description: 'Represents an ARGB colour value.',
      url: 'https://documentation.xojo.com/api/graphics/color.html'
    },
    'Date': {
      description: 'Represents a date and time value (legacy).',
      url: 'https://documentation.xojo.com/api/language/date.html'
    },
    'DateTime': {
      description: 'Represents a date and time value (modern replacement for Date).',
      url: 'https://documentation.xojo.com/api/dates_and_times/datetime.html'
    },
    'FolderItem': {
      description: 'Represents a file or folder on disk.',
      url: 'https://documentation.xojo.com/api/files/folderitem.html'
    },
    // Keywords
    'Dim': {
      description: 'Declares a local variable.',
      url: 'https://documentation.xojo.com/api/language/dim.html'
    },
    'Var': {
      description: 'Declares a local variable (modern alias for Dim).',
      url: 'https://documentation.xojo.com/api/language/var.html'
    },
    'Const': {
      description: 'Declares a compile-time constant.',
      url: 'https://documentation.xojo.com/api/language/const.html'
    },
    'If': {
      description: 'Executes a block of code conditionally.',
      url: 'https://documentation.xojo.com/api/language/if...then...else.html'
    },
    'Select': {
      description: 'Evaluates an expression and branches to a matching Case.',
      url: 'https://documentation.xojo.com/api/language/select_case.html'
    },
    'For': {
      description: 'Repeats a block a fixed number of times.',
      url: 'https://documentation.xojo.com/api/language/for...next.html'
    },
    'While': {
      description: 'Repeats a block while a condition is true.',
      url: 'https://documentation.xojo.com/api/language/while...wend.html'
    },
    'Do': {
      description: 'Repeats a block until a condition is met.',
      url: 'https://documentation.xojo.com/api/language/do...loop.html'
    },
    'Try': {
      description: 'Catches runtime exceptions.',
      url: 'https://documentation.xojo.com/api/language/try.html'
    },
    'Raise': {
      description: 'Throws a runtime exception.',
      url: 'https://documentation.xojo.com/api/language/raise.html'
    },
    'Return': {
      description: 'Returns a value from a Function or exits a Sub.',
      url: 'https://documentation.xojo.com/api/language/return.html'
    },
    'Nil': {
      description: 'Represents a null object reference.',
      url: 'https://documentation.xojo.com/api/language/nil.html'
    },
    'Me': {
      description: 'Refers to the current object instance.',
      url: 'https://documentation.xojo.com/api/language/me.html'
    },
    'Super': {
      description: 'Calls a method on the superclass.',
      url: 'https://documentation.xojo.com/api/language/super.html'
    },
    'New': {
      description: 'Creates a new instance of a class.',
      url: 'https://documentation.xojo.com/api/language/new.html'
    },
    'IsA': {
      description: 'Tests whether an object is an instance of a class.',
      url: 'https://documentation.xojo.com/api/language/isa.html'
    },
    'AddHandler': {
      description: 'Dynamically assigns an event handler at runtime.',
      url: 'https://documentation.xojo.com/api/language/addhandler.html'
    },
    'RemoveHandler': {
      description: 'Removes a dynamically assigned event handler.',
      url: 'https://documentation.xojo.com/api/language/removehandler.html'
    },
    // Common exceptions
    'NilObjectException': {
      description: 'Raised when a Nil object reference is dereferenced.',
      url: 'https://documentation.xojo.com/api/language/nilobjectexception.html'
    },
    'OutOfBoundsException': {
      description: 'Raised when an array or string index is out of bounds.',
      url: 'https://documentation.xojo.com/api/language/outofboundsexception.html'
    },
    'RuntimeException': {
      description: 'The base class for all Xojo runtime exceptions.',
      url: 'https://documentation.xojo.com/api/language/runtimeexception.html'
    },
};

/**
 * Provides hover tooltips for Xojo keywords and types in .xojo edit files.
 */
export class XojoHoverProvider implements vscode.HoverProvider {
  provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.Hover | undefined {
    const wordRange = doc.getWordRangeAtPosition(pos);
    if (!wordRange) return undefined;

    const word  = doc.getText(wordRange);
    const entry = BUILTIN_DOCS[word];
    if (!entry) return undefined;

    const md = new vscode.MarkdownString(
      `**${word}** — ${entry.description}\n\n[Xojo Docs ↗](${entry.url})`
    );
    md.isTrusted = true;
    return new vscode.Hover(md, wordRange);
  }
}
