/// <reference types="@types/codemirror" />

import debounce from 'lodash-es/debounce';
import isEqual from 'lodash-es/isEqual';
import * as lsProtocol from 'vscode-languageserver-protocol';
import {
  Location,
  LocationLink,
  MarkupContent,
  CompletionItemKind
} from 'vscode-languageserver-protocol';
import { marked } from 'marked';
import {
  getFilledDefaults,
  IEditorAdapter,
  ILspConnection,
  IPosition,
  ITextEditorOptions,
  ITokenInfo,
  ICompletionTokenInfo,
  TooltipData,
} from './types';
import * as CodeMirror from 'codemirror';

interface IScreenCoord {
  x: number;
  y: number;
}

class CodeMirrorAdapter extends IEditorAdapter<CodeMirror.Editor> {
  public options: ITextEditorOptions;
  public editor: CodeMirror.Editor;
  public connection: ILspConnection;
	public snippets: lsProtocol.CompletionItem[];

  private hoverMarker: CodeMirror.TextMarker;
  private signatureWidget: CodeMirror.LineWidget;
  private token: ICompletionTokenInfo;
  private markedDiagnostics: CodeMirror.TextMarker[] = [];
  private diagnosticResults: ITokenInfo[] = [];
  private highlightMarkers: CodeMirror.TextMarker[] = [];
  private hoverCharacter: IPosition;
  private debouncedGetHover: (position: IPosition) => void;
  private connectionListeners: { [key: string]: () => void } = {};
  private editorListeners: { [key: string]: () => void } = {};
  private documentListeners: { [key: string]: () => void } = {};
  private tooltip: HTMLElement;
  private isShowingContextMenu: boolean = false;

  constructor(
    connection: ILspConnection,
    options: ITextEditorOptions,
    editor: CodeMirror.Editor,
		snippets: lsProtocol.CompletionItem[]
  ) {
    super(connection, options, editor);
    this.connection = connection;
    this.options = getFilledDefaults(options);
    this.editor = editor;
    this.snippets = snippets;

    this.debouncedGetHover = debounce((position: IPosition) => {
      if (!this.options.enableDiagnostics && !this.options.enableHoverInfo) {
        return;
      }
      this.connection.getHoverTooltip(position);
    }, this.options.quickSuggestionsDelay);

    this._addListeners();
  }

  public updateOptions(options: ITextEditorOptions) {
    this.options = getFilledDefaults(options);
    if (!this.options.enableDiagnostics) {
      this._clearDiagnostics();
    }
  }

  public updateSnippets(newSnippets: lsProtocol.CompletionItem[]) {
    this.snippets = newSnippets;
  }

  public handleMouseLeave() {
    // this._removeHover();
    // this._removeTooltip();
  }

  public handleMouseOver(ev: MouseEvent) {
    if (!this._isEventOnCharacter(ev) || this._isEventOnTooltip(ev)) {
      return;
    }
    if (!this._isEventInsideVisible(ev)) {
      this._removeHover();
      this._removeTooltip();
      return;
    }

    const docPosition: IPosition = this.editor.coordsChar(
      {
        left: ev.clientX,
        top: ev.clientY,
      },
      'window'
    );

    if (
      !(
        this.hoverCharacter &&
        docPosition.line === this.hoverCharacter.line &&
        docPosition.ch === this.hoverCharacter.ch
      )
    ) {
      // Avoid sending duplicate requests in a row
      this.hoverCharacter = docPosition;
      this.debouncedGetHover(docPosition);
    }
  }

  public handleChange(cm: CodeMirror.Editor, change: CodeMirror.EditorChange) {
    const location = this.editor.getDoc().getCursor('end');
    this.connection.sendChange();
    const completionCharacters = this.connection.getLanguageCompletionCharacters();
    const signatureCharacters = this.connection.getLanguageSignatureCharacters();
    const code = this.editor.getValue();
    const line = this.editor.getLine(location.line);
    const typedCharacter = line[location.ch - 1];
    if (typeof typedCharacter === 'undefined') {
      // Line was cleared
      this._removeSignatureWidget();
    } else if (completionCharacters.indexOf(typedCharacter) > -1) {
      this.token = this._getTokenEndingAtPosition(
        code,
        location,
        completionCharacters
      );
      this.connection.getCompletion(
        location,
        this.token,
        completionCharacters.find(c => c === typedCharacter),
        lsProtocol.CompletionTriggerKind.TriggerCharacter
      );
    } else if (signatureCharacters.indexOf(typedCharacter) > -1) {
      this.token = this._getTokenEndingAtPosition(
        code,
        location,
        signatureCharacters
      );
      this.connection.getSignatureHelp(location);
    } else if (!/\W/.test(typedCharacter)) {
      this.connection.getCompletion(
        location,
        this.token,
        '',
        lsProtocol.CompletionTriggerKind.Invoked
      );
      this.token = this._getTokenEndingAtPosition(
        code,
        location,
        completionCharacters.concat(signatureCharacters)
      );
    } else {
      this._removeSignatureWidget();
    }
  }

  public handleRefresh() {
    this._removeHover();
    this._removeTooltip();
  }

  public handleScrollLeave() {
    this._removeHover();
    this._removeTooltip();
  }

  public handleHover(response: lsProtocol.Hover, position: IPosition) {
    this._removeHover();
    this._removeTooltip();

    const tooltipData: TooltipData = {
      hasData: false,
      x: 0,
      y: 0,
    }

    this.diagnosticResults.forEach((diagnostic: ITokenInfo) => {
      if (
        position.line === diagnostic.start.line ||
        position.line === diagnostic.end.line
      ) {
        if (
          position.ch >= diagnostic.start.ch &&
          position.ch <= diagnostic.end.ch
        ) {
          const htmlElement = document.createElement('ul');
          htmlElement.classList.add("lsp-inner");
          htmlElement.innerHTML = diagnostic.text
            .map(text => `<li class="lsp-inner-li">${text}</li>`)
            .join('');

          const coords = this.editor.charCoords(diagnostic.start, 'local');
          const scrollCords = this.editor.getScrollInfo();
          tooltipData.hasData = true;
          tooltipData.x = coords.left - scrollCords.left;
          tooltipData.y = coords.top - scrollCords.top;
          tooltipData.htmlElement = htmlElement;
        }
      }
    });

    if (!this.options.enableHoverInfo || !response || !response.contents || (Array.isArray(response.contents) && response.contents.length === 0)) {
      this._showTooltipWithData(tooltipData);
      return;
    }

    let start = this.hoverCharacter;
    let end = this.hoverCharacter;
    if (response.range) {
      start = {
        line: response.range.start.line,
        ch: response.range.start.character,
      } as CodeMirror.Position;
      end = {
        line: response.range.end.line,
        ch: response.range.end.character,
      } as CodeMirror.Position;

      this.hoverMarker = this.editor.getDoc().markText(start, end, {
        className: 'CodeMirror-lsp-hover'
      });
    }
    if (
      position.ch < start.ch ||
      position.ch > end.ch ||
      position.line !== start.line ||
      position.line !== end.line
    ) {
      this._showTooltipWithData(tooltipData);
      return;
    }

    let tooltipText: string;
    let isMarkdown: boolean;
    if (MarkupContent.is(response.contents)) {
      tooltipText = response.contents.value;
      isMarkdown = response.contents.kind === 'markdown';
    } else if (Array.isArray(response.contents)) {
      const firstItem = response.contents[0];
      if (MarkupContent.is(firstItem)) {
        tooltipText = firstItem.value;
      } else if (firstItem === null) {
        this._showTooltipWithData(tooltipData);
        return;
      } else if (typeof firstItem === 'object') {
        tooltipText = firstItem.value;
      } else {
        tooltipText = firstItem;
      }
    } else if (typeof response.contents === 'string') {
      tooltipText = response.contents;
    }

    const wrapper = document.createElement('div');

    const signatureElement = document.createElement('div');
    signatureElement.classList.add("lsp-inner");
    if (isMarkdown) {
      signatureElement.classList.add("lsp-markdown");
      signatureElement.innerHTML = marked.parse(tooltipText);
      signatureElement.addEventListener('click', (event) => {
        event.preventDefault();
        const target = event.target as HTMLAnchorElement;
        if (target.href) {
          CodeMirror.signal(this.editor,'lsp/open', target.href);
        }
      })
    } else {
      signatureElement.innerText = tooltipText;
    }
    const coords = this.editor.charCoords(start, 'local');
    const scrollCords = this.editor.getScrollInfo();
    const left = coords.left - scrollCords.left;
    const top = coords.top - scrollCords.top;

    if (tooltipData.hasData && tooltipData.x === left && tooltipData.y === top) {
      wrapper.appendChild(tooltipData.htmlElement);
      wrapper.appendChild(signatureElement);
    }
    wrapper.appendChild(signatureElement);

    this._showTooltip(wrapper, {
      x: left,
      y: top,
    });
  }

  private _showTooltipWithData(tooltipData: TooltipData) {
    if (tooltipData.hasData) {
      this._showTooltip(tooltipData.htmlElement, {
        x: tooltipData.x,
        y: tooltipData.y,
      });
    }
  }

  public handleHighlight(items: lsProtocol.DocumentHighlight[]) {
    this._highlightRanges((items || []).map(i => i.range));
  }

  public handleCompletion(completions: lsProtocol.CompletionItem[]): void {
    if (!this.token || !this.options.suggest) {
      return;
    }

    const bestCompletions = this._getFilteredCompletions(
      this.token.text,
      completions,
      false
    );
    const bestSnippets = this._getFilteredCompletions(this.token.text, this.snippets, true);
    let start = this.token.start;
    if (/^\W$/.test(this.token.text)) {
      // Special case for completion on the completion trigger itself, the completion goes after
      start = this.token.end;
    }
    (this.editor as any).showHint({
      completeSingle: false,
      hint: () => {
        return {
          from: start,
          to: this.token.end,
          list: [...this._getHintList(bestSnippets), ...this._getHintList(bestCompletions)]
        };
      },
    });
  }
  private _getText(completion: ICompletionTokenInfo) {
    if (typeof completion == "string") return completion;
    else return completion.text;
  }
  private _getHintList(hints: lsProtocol.CompletionItem[]) {
    // @ts-ignore
    return hints.map(({ label, labelDetails, insertText, kind }) => {
      return {
        text: insertText || label,
        displayText: label,
        render: (element: HTMLElement) => {
          const wrapper = document.createElement('span');
          const text = document.createElement('span');
          const descriptionText = document.createElement('span');
          text.innerText = label;

          const icon = document.createElement('i');
          icon.classList.add('autocomplete-icon', `icon-symbol-${this._getIconByKind(kind)}`);
          wrapper.append(icon);
          wrapper.append(text);
          
          element.append(wrapper);
          if (labelDetails) {
            descriptionText.classList.add('description');
            descriptionText.innerText = labelDetails as string;
            element.append(descriptionText);
          }
        },
        hint: (cm: CodeMirror.Editor, data: any, completion: any) => {
          const text = this._getText(completion);
          const from = completion.from || data.from
          const { line, ch } = from;
          cm.replaceRange(text.replace(/\$0/g, ''), from, completion.to || data.to, "complete");

          if (text.includes('$0')) {
            let cursorLine = line;
            let cursorCh = ch;
            const textArr = text.split('\n');
            textArr.forEach((str, index) => {
              const pos = str.lastIndexOf('$0');
              if (pos > -1) {
                cursorLine = line + index;
                cursorCh = pos;
              }
            })

            cm.setCursor(cursorLine,cursorCh);
          }
        }
      };
    });
  }
  private _getIconByKind(kind: number) {
    switch (kind) {
      case CompletionItemKind.Method:
      case CompletionItemKind.Function:
      case CompletionItemKind.Constructor:
        return 'method';
      case CompletionItemKind.Field:
        return 'field';
      case CompletionItemKind.Variable:
        return 'variable';
      case CompletionItemKind.Class:
        return 'class';
      case CompletionItemKind.Struct:
        return 'structure';
      case CompletionItemKind.Interface:
        return 'interface';
      case CompletionItemKind.Module:
        return 'namespace';
      case CompletionItemKind.Property:
        return 'property';
      case CompletionItemKind.Event:
        return 'event';
      case CompletionItemKind.Operator:
        return 'operator';
      case CompletionItemKind.Unit:
        return 'ruler';
      case CompletionItemKind.Constant:
        return 'constant';
      case CompletionItemKind.Enum:
      case CompletionItemKind.Value:
        return 'enum';
      case CompletionItemKind.EnumMember:
        return 'enum-member';
      case CompletionItemKind.Keyword:
        return 'keyword';
      case CompletionItemKind.Snippet:
        return 'snippet';
      case CompletionItemKind.Text:
        return 'string';
      case CompletionItemKind.Color:
        return 'color';
      case CompletionItemKind.File:
        return 'file';
      case CompletionItemKind.Reference:
        return 'misc';
      case CompletionItemKind.Folder:
        return 'file';
      case CompletionItemKind.TypeParameter:
        return 'parameter';
      default:
        return 'property';
    }
  }
  private _clearDiagnostics() {
    this.editor.clearGutter('CodeMirror-lsp');
    this.markedDiagnostics.forEach(marker => {
      marker.clear();
    });
    this.markedDiagnostics = [];
    this.diagnosticResults = [];
  }
  public handleDiagnostic(response: lsProtocol.PublishDiagnosticsParams) {
    if (!this.options.enableDiagnostics) return;
    this._clearDiagnostics();
    CodeMirror.signal(this.editor, 'lsp/diagnostics', response.diagnostics);
    response.diagnostics.forEach((diagnostic: lsProtocol.Diagnostic) => {
      const start = {
        line: diagnostic.range.start.line,
        ch: diagnostic.range.start.character,
      } as CodeMirror.Position;
      const end = {
        line: diagnostic.range.end.line,
        ch: diagnostic.range.end.character,
      } as CodeMirror.Position;

      this.markedDiagnostics.push(
        this.editor.getDoc().markText(start, end, {
          className: this.options.diagnosticMarkClassName,
        })
      );

      const duplicateIndex = this.diagnosticResults.findIndex(
        result => isEqual(result.start, start) && isEqual(result.end, end)
      );
      if (duplicateIndex > -1) {
        this.diagnosticResults[duplicateIndex].text.push(diagnostic.message);
      } else {
        this.diagnosticResults.push({
          text: [diagnostic.message],
          start,
          end,
        });
      }

      if (this.options.enableGutterMarks) {
        const childEl = document.createElement('div');
        childEl.classList.add('CodeMirror-lsp-guttermarker');
        childEl.title = diagnostic.message;
        this.editor.setGutterMarker(start.line, 'CodeMirror-lsp', childEl);
      }
    });
  }

  public handleSignature(result: lsProtocol.SignatureHelp) {
    this._removeSignatureWidget();
    this._removeTooltip();
    if (!this.options.enableSignatures || !result || !result.signatures.length || !this.token) {
      return;
    }

    const htmlElement = document.createElement('div');
    htmlElement.classList.add("lsp-inner");
    result.signatures.forEach((item: lsProtocol.SignatureInformation) => {
      const el = document.createElement('div');
      el.innerText = item.label;
      htmlElement.appendChild(el);
    });
    const coords = this.editor.charCoords(this.token.start, 'local');
    const scrollCords = this.editor.getScrollInfo();
    const left = coords.left - scrollCords.left;
    const top = coords.top - scrollCords.top;
    this._showTooltip(htmlElement, {
      x: left,
      y: top,
    });
  }

  public handleGoTo(location: Location | Location[] | LocationLink[] | null) {
    this._removeTooltip();

    if (!location) {
      return;
    }

    const documentUri = this.connection.getDocumentUri();
    let scrollTo: IPosition;
    if (lsProtocol.Location.is(location)) {
      if (location.uri !== documentUri) {
        return;
      }
      this._highlightRanges([location.range]);
      scrollTo = {
        line: location.range.start.line,
        ch: location.range.start.character,
      };
    } else if ((location as any[]).every(l => lsProtocol.Location.is(l))) {
      const locations = (location as Location[]).filter(l => {
        return l.uri === documentUri;
      });
      this._highlightRanges(locations.map(l => l.range));
      scrollTo = {
        line: locations[0].range.start.line,
        ch: locations[0].range.start.character,
      };
    } else if ((location as any[]).every(l => lsProtocol.LocationLink.is(l))) {
      const locations = (location as LocationLink[]).filter(
        l => l.targetUri === documentUri
      );
      this._highlightRanges(locations.map(l => l.targetRange));
      scrollTo = {
        line: locations[0].targetRange.start.line,
        ch: locations[0].targetRange.start.character,
      };
    }
    this.editor.scrollIntoView(scrollTo);
  }

  public remove() {
    this._removeSignatureWidget();
    this._removeHover();
    this._removeTooltip();
    this._clearDiagnostics();
    // Show-hint addon doesn't remove itself. This could remove other uses in the project
    this.editor
      .getWrapperElement()
      .querySelectorAll('.CodeMirror-hints')
      .forEach(e => e.remove());
    this.editor.off('change', this.editorListeners.change);
    this.editor.off('cursorActivity', this.editorListeners.cursorActivity);
    this.editor
      .getWrapperElement()
      .removeEventListener('mousemove', this.editorListeners.mouseover);
    if (this.options.enableContextMenu) {
      this.editor
        .getWrapperElement()
        .removeEventListener('contextmenu', this.editorListeners.contextmenu);
    }
    Object.keys(this.connectionListeners).forEach(key => {
      this.connection.off(key as any, this.connectionListeners[key]);
    });
    Object.keys(this.documentListeners).forEach(key => {
      document.removeEventListener(key as any, this.documentListeners[key]);
    });
  }

  private _addListeners() {
    const changeListener = debounce(
      this.handleChange.bind(this),
      this.options.debounceSuggestionsWhileTyping
    );
    this.editor.on('change', changeListener);
    this.editorListeners.change = changeListener;

    const self = this;
    this.connectionListeners = {
      hover: this.handleHover.bind(self),
      // highlight: this.handleHighlight.bind(self),

      completion: this.handleCompletion.bind(self),
      signature: this.handleSignature.bind(self),
      diagnostic: this.handleDiagnostic.bind(self),
      // goTo: this.handleGoTo.bind(self),
    };

    Object.keys(this.connectionListeners).forEach(key => {
      this.connection.on(key as any, this.connectionListeners[key]);
    });

    const refreshListener = this.handleRefresh.bind(this);
    this.editor.on('refresh', refreshListener);
    this.editorListeners.refresh = refreshListener;

    const mouseLeaveListener = this.handleMouseLeave.bind(this);
    this.editor
      .getWrapperElement()
      .addEventListener('mouseleave', mouseLeaveListener);
    this.editorListeners.mouseleave = mouseLeaveListener;

    const scrollListener = this.handleScrollLeave.bind(this);
    this.editor.on('scroll', scrollListener);
    this.editorListeners.scroll = scrollListener;

    const mouseOverListener = this.handleMouseOver.bind(this);
    this.editor.getWrapperElement().addEventListener('mousemove', mouseOverListener);
    this.editorListeners.mouseover = mouseOverListener;

    // const debouncedCursor = debounce(() => {
    //   this.connection.getDocumentHighlights(this.editor.getDoc().getCursor('start'));
    // }, this.options.quickSuggestionsDelay);

    if (this.options.enableContextMenu) {
      const rightClickHandler = this._handleRightClick.bind(this);
      this.editor
        .getWrapperElement()
        .addEventListener('contextmenu', rightClickHandler);
      this.editorListeners.contextmenu = rightClickHandler;
    }
    // this.editor.on('cursorActivity', debouncedCursor);
    // this.editorListeners.cursorActivity = debouncedCursor;

    const clickOutsideListener = this._handleClickOutside.bind(this);
    document.addEventListener('click', clickOutsideListener);
    this.documentListeners.clickOutside = clickOutsideListener;

    const clickInsideListener = this._handleClickInside.bind(this);
    this.editor.on('focus', clickInsideListener);
    this.documentListeners.clickInside = clickInsideListener;
  }

  private _getTokenEndingAtPosition(
    code: string,
    location: IPosition,
    splitCharacters: string[]
  ): ICompletionTokenInfo {
    const lines = code.split('\n');
    const line = lines[location.line];
    const typedCharacter = line[location.ch - 1];

    if (splitCharacters.indexOf(typedCharacter) > -1) {
      return {
        text: typedCharacter,
        start: {
          line: location.line,
          ch: location.ch - 1,
        },
        end: location,
      };
    }

    let wordStartChar = 0;
    for (let i = location.ch - 1; i >= 0; i--) {
      const char = line[i];
      if (/\W/u.test(char)) {
        break;
      }
      wordStartChar = i;
    }
    return {
      text: line.substr(wordStartChar, location.ch),
      start: {
        line: location.line,
        ch: wordStartChar,
      },
      end: location,
    };
  }

  private _getFilteredCompletions(
    triggerWord: string,
    items: lsProtocol.CompletionItem[],
    canMatchWholeWord: boolean
  ): lsProtocol.CompletionItem[] {
    const firstWord = triggerWord.split(/\W+/)[0];
    if (/\W+/.test(firstWord) || !items) {
      return [];
    }
    const word = firstWord.toLowerCase();
    return items
      .filter((item: lsProtocol.CompletionItem) => {
        const label = item.label.toLocaleLowerCase();
        if (item.filterText && item.filterText.toLowerCase().startsWith(word) === true) {
          return true;
        } else if (canMatchWholeWord === false && label === word ) {
          return false;
        } else {
          return label.startsWith(word) === true;
        }
      })
      .sort((a: lsProtocol.CompletionItem, b: lsProtocol.CompletionItem) => {
        const labelA = a.label.toLocaleLowerCase();
        const labelB = b.label.toLocaleLowerCase();
        const inA = labelA.startsWith(word) === true ? -1 : 1;
        const inB = labelB.startsWith(word) === true ? 1 : -1;
        return inA + inB;
      });
  }

  private _isEventOnTooltip(ev: MouseEvent) {
    if (!this.isShowingContextMenu) return;
    const target: HTMLElement = ev.target as HTMLElement;

    if (target.classList.contains('CodeMirror-lsp-tooltip') || target.tagName === 'A') {
      return true;
    }
    return false;
  }

  private _isEventInsideVisible(ev: MouseEvent) {
    // Only handle mouseovers inside CodeMirror's bounding box
    let isInsideSizer = false;
    let target: HTMLElement = ev.target as HTMLElement;
    while (target !== document.body) {
      if (target.classList.contains('CodeMirror')) {
        isInsideSizer = true;
        break;
      }
      target = target.parentElement;
    }

    return isInsideSizer;
  }

  private _isEventOnCharacter(ev: MouseEvent) {
    const docPosition: IPosition = this.editor.coordsChar(
      {
        left: ev.clientX,
        top: ev.clientY,
      },
      'window'
    );

    const token = this.editor.getTokenAt(docPosition);
    const hasToken = !!token.string.length;

    return hasToken;
  }

  private _handleRightClick(ev: MouseEvent) {
    if (!this._isEventInsideVisible(ev) || !this._isEventOnCharacter(ev)) {
      return;
    }

    if (
      !this.connection.isDefinitionSupported() &&
      !this.connection.isTypeDefinitionSupported() &&
      !this.connection.isReferencesSupported()
    ) {
      return;
    }

    ev.preventDefault();

    const docPosition: IPosition = this.editor.coordsChar(
      {
        left: ev.clientX,
        top: ev.clientY,
      },
      'window'
    );

    if (this.options.contextMenuProvider) {
      let features: Array<{ label: String; action: any }> = [];
      if (this.connection.isDefinitionSupported()) {
        features.push({
          label: 'Go to Definition',
          action: () => this.connection.getDefinition(docPosition),
        });
      }
      if (this.connection.isTypeDefinitionSupported()) {
        features.push({
          label: 'Go to Type Definition',
          action: () => this.connection.getTypeDefinition(docPosition),
        });
      }
      if (this.connection.isReferencesSupported()) {
        features.push({
          label: 'Find all References',
          action: () => this.connection.getReferences(docPosition),
        });
      }
      this.options.contextMenuProvider(ev, features);
    } else {
      const htmlElement = document.createElement('div');
      htmlElement.classList.add('CodeMirror-lsp-context');

      if (this.connection.isDefinitionSupported()) {
        const goToDefinition = document.createElement('div');
        goToDefinition.innerText = 'Go to Definition';
        goToDefinition.addEventListener('click', () => {
          this.connection.getDefinition(docPosition);
        });
        htmlElement.appendChild(goToDefinition);
      }

      if (this.connection.isTypeDefinitionSupported()) {
        const goToTypeDefinition = document.createElement('div');
        goToTypeDefinition.innerText = 'Go to Type Definition';
        goToTypeDefinition.addEventListener('click', () => {
          this.connection.getTypeDefinition(docPosition);
        });
        htmlElement.appendChild(goToTypeDefinition);
      }

      if (this.connection.isReferencesSupported()) {
        const getReferences = document.createElement('div');
        getReferences.innerText = 'Find all References';
        getReferences.addEventListener('click', () => {
          this.connection.getReferences(docPosition);
        });
        htmlElement.appendChild(getReferences);
      }
      const coords = this.editor.charCoords(docPosition, 'page');
      this._showTooltip(htmlElement, {
        x: ev.x - 4,
        y: ev.y + 8,
      });
    }
  }

  private _handleClickInside(ev: MouseEvent) {
    this._unhighlightRanges();
  }

  private _handleClickOutside(ev: MouseEvent) {
    if (this.isShowingContextMenu) {
      let target: HTMLElement = ev.target as HTMLElement;
      let isInside = false;
      while (target && target !== document.body) {
        if (target && target.classList.contains('CodeMirror-lsp-tooltip')) {
          isInside = true;
          break;
        }
        target = target?.parentElement;
      }

      if (isInside) {
        return;
      }

      // Only remove tooltip if clicked outside right click
      this._removeTooltip();
    }
  }

  private _showTooltip(el: HTMLElement, coords: IScreenCoord) {
    if (this.isShowingContextMenu) {
      this._removeTooltip();
    }

    let top = coords.y - this.editor.defaultTextHeight();
    const altTop = coords.y + this.editor.defaultTextHeight();

    this.tooltip = document.createElement('div');
    this.tooltip.classList.add('CodeMirror-lsp-tooltip');
    this.tooltip.setAttribute('tabindex', '-1');
    this.tooltip.style.left = `${coords.x}px`;
    this.tooltip.style.top = `${top}px`;
    this.tooltip.appendChild(el);
    this.editor.getWrapperElement().appendChild(this.tooltip);

    // Measure and reposition after rendering first version
    requestAnimationFrame(() => {
      top += this.editor.defaultTextHeight();
      top -= this.tooltip.offsetHeight;

      this.tooltip.style.left = `${coords.x}px`;
      this.tooltip.style.top = top < 0 ? `${altTop}px` : `${top}px`;
    });

    this.isShowingContextMenu = true;
  }

  private _removeTooltip() {
    if (this.tooltip) {
      this.isShowingContextMenu = false;
      this.tooltip.remove();
    }
  }

  private _removeSignatureWidget() {
    if (this.signatureWidget) {
      this.signatureWidget.clear();
      this.signatureWidget = null;
    }
    if (this.tooltip) {
      this._removeTooltip();
    }
  }

  private _removeHover() {
    if (this.hoverMarker) {
      this.hoverMarker.clear();
      this.hoverMarker = null;
    }
  }

  private _unhighlightRanges() {
    if (this.highlightMarkers) {
      this.highlightMarkers.forEach(marker => {
        marker.clear();
      });
    }
    this.highlightMarkers = [];
  }
  private _highlightRanges(items: lsProtocol.Range[]) {
    this._unhighlightRanges();

    if (!items.length) {
      return;
    }

    items.forEach(item => {
      const start = {
        line: item.start.line,
        ch: item.start.character,
      } as CodeMirror.Position;
      const end = {
        line: item.end.line,
        ch: item.end.character,
      } as CodeMirror.Position;

      this.highlightMarkers.push(
        this.editor.getDoc().markText(start, end, {
          className: 'CodeMirror-lsp-highlight',
        })
      );
    });
  }
}

export default CodeMirrorAdapter;
