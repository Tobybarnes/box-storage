import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

export function editorExtensions() {
    return [StarterKit.configure({
        underline: false, trailingNode: false,
        link: { openOnClick: false, autolink: false },
    }), Markdown];
}

function escapeTitle(value) {
    return value.replace(/([\\`*_{}\[\]()<>!#|~&])/g, '\\$1');
}

export function composeNote(original, title, bodyChanged, markdownBody) {
    const titleChanged = title !== original.title;
    if (!titleChanged && !bodyChanged) return original.source;
    let head = original.head;
    if (titleChanged) {
        const prefix = original.titlePrefix + (/\s$/.test(original.titlePrefix) ? '' : ' ');
        head = prefix + escapeTitle(title) + original.titleSuffix;
    }
    if (!bodyChanged) return head + original.body;
    const newline = original.newline;
    const body = markdownBody.replace(/\r\n?/g, '\n').replace(/\n/g, newline);
    if (!head) return body;
    const separator = /[\r\n]$/.test(head) ? newline : newline + newline;
    return head + separator + body;
}
