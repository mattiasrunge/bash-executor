import { assertEquals } from '@std/assert';
import { History } from '../src/history.ts';
import { type EditorResult, LineEditor, splitKeys } from '../src/line-editor.ts';

/** An editor over a history of these lines. */
const editorWith = (lines: string[] = [], max?: number) => {
  const history = new History();

  history.max = max;
  for (const line of lines) history.add(line);

  const editor = new LineEditor(() => history);

  editor.start();

  return { editor, history };
};

/** Type the text and say what the last key came to. */
const type = (editor: LineEditor, text: string): EditorResult | undefined => editor.feedText(text).at(-1);

Deno.test('splitKeys', async (t) => {
  await t.step('characters, control characters, sequences and meta keys', () => {
    assertEquals(splitKeys('a\x01\x1b[A\x1bOH\x1bb\x1b[1;5C\x1b[3~é'), { keys: ['a', '\x01', '\x1b[A', '\x1bOH', '\x1bb', '\x1b[1;5C', '\x1b[3~', 'é'], rest: '' });
  });

  await t.step('a sequence cut off waits for the rest', () => {
    assertEquals(splitKeys('ab\x1b['), { keys: ['a', 'b'], rest: '\x1b[' });
  });
});

Deno.test('editing a line as readline does', async (t) => {
  await t.step('moving and inserting', () => {
    const { editor } = editorWith();

    type(editor, 'world\x01hello \x05!');
    assertEquals([editor.line, editor.point], ['hello world!', 12]);
    type(editor, '\x02\x02\x1bb');
    assertEquals(editor.point, 6);
  });

  await t.step('killing and yanking, kills in a row joined', () => {
    const { editor } = editorWith();

    type(editor, 'one two three\x17\x17');
    assertEquals(editor.line, 'one ');
    type(editor, '\x01\x0b\x19');
    assertEquals(editor.line, 'one ');
    type(editor, '\x15x\x19');
    assertEquals(editor.line, 'xone ');
  });

  await t.step('C-d deletes, and on an empty line is the end', () => {
    const { editor } = editorWith();

    assertEquals(type(editor, 'ab\x01\x04'), { kind: 'edit' });
    assertEquals(editor.line, 'b');
    type(editor, '\x04');
    assertEquals(type(editor, '\x04'), { kind: 'eof' });
  });

  await t.step('C-t swaps, at the end the last two', () => {
    const { editor } = editorWith();

    type(editor, 'ab\x14');
    assertEquals(editor.line, 'ba');
  });

  await t.step('C-v puts the next key in as it is', () => {
    const { editor } = editorWith();

    type(editor, 'a\x16\x01');
    assertEquals(editor.line, 'a\x01');
  });

  await t.step('Enter accepts, and keys typed past it wait for the next line', () => {
    const { editor } = editorWith();

    assertEquals(editor.feedText('ls\rpwd\r'), [{ kind: 'edit' }, { kind: 'edit' }, { kind: 'accept', line: 'ls' }]);
    editor.start();
    assertEquals(editor.drain().at(-1), { kind: 'accept', line: 'pwd' });
  });
});

Deno.test('the history', async (t) => {
  await t.step('C-p and C-n step through it, keeping what was being typed', () => {
    const { editor } = editorWith(['a', 'b']);

    type(editor, 'new\x10');
    assertEquals(editor.line, 'b');
    type(editor, '\x10');
    assertEquals(editor.line, 'a');
    assertEquals(type(editor, '\x10'), { kind: 'bell' });
    type(editor, '\x0e\x0e');
    assertEquals(editor.line, 'new');
    type(editor, '\x1b<');
    assertEquals(editor.line, 'a');
  });

  await t.step('C-r searches back as one types, C-r again goes further', () => {
    const { editor } = editorWith(['echo left 1', 'mid', 'echo left 2']);

    type(editor, '\x12le');
    assertEquals(editor.display('$ '), { prompt: "(reverse-i-search)`le': ", line: 'echo left 2', cursor: 5 });
    type(editor, '\x12');
    assertEquals(editor.line, 'echo left 1');
    type(editor, 'x');
    assertEquals(editor.display('$ ').prompt, "(failed reverse-i-search)`lex': ");
  });

  await t.step('C-g goes back to where the search began, any other key keeps the match', () => {
    const { editor } = editorWith(['make test']);

    type(editor, 'ls\x12mak\x07');
    assertEquals([editor.line, editor.searching], ['ls', false]);
    type(editor, '\x12mak\x05');
    assertEquals([editor.line, editor.point, editor.searching], ['make test', 9, false]);
  });

  await t.step('C-o runs the line and brings back the one after it, the history stifled or not', () => {
    const { editor, history } = editorWith(['echo a', 'echo b', 'echo c'], 3);

    type(editor, '\x10\x10');
    assertEquals(type(editor, '\x0f'), { kind: 'accept', line: 'echo b' });
    // The shell keeps the line run, and the oldest goes
    history.add('echo b');
    editor.start();
    assertEquals(editor.line, 'echo c');
  });

  await t.step('Enter after a search runs what was found', () => {
    const { editor } = editorWith(['git status']);

    assertEquals(type(editor, '\x12stat\r'), { kind: 'accept', line: 'git status' });
  });
});

Deno.test('Tab', async (t) => {
  await t.step('a Tab lists the matches when the one before it changed nothing, as readline has it', () => {
    const { editor } = editorWith();

    assertEquals(type(editor, 'ls s\t'), { kind: 'complete', list: false });
    // The prefix the matches share went in
    editor.completed('ls sr');
    assertEquals(type(editor, '\t'), { kind: 'complete', list: false });
    // Nothing more to add
    editor.completed('ls sr');
    assertEquals(type(editor, '\t'), { kind: 'complete', list: true });
  });
});
