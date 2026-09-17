import { occurrencesFor } from './occurrence';
export type ReadingPolicy = "automatic" | "selection";
export const WORD_PATTERN = /[A-Za-z]+(?:['-][A-Za-z]+)*/g;
const EXCLUDED = "script,style,noscript,template,svg,canvas,math,textarea,input,select,option,pre,code,kbd,samp,var,[contenteditable='true'],[contenteditable=''],[hidden],[aria-hidden='true'],[translate='no'],.notranslate,.imt-notranslate,[data-glossa-owned='1'],[data-glossa-label],#glossa-overlay";
export function isReadableElement(element: Element, includeSource = false, policy: ReadingPolicy = "automatic"): boolean {
  if (includeSource && occurrencesFor(element.ownerDocument).sourceScaffold(element)) return true;
  if (element.matches(EXCLUDED) || (element.tagName === "BUTTON" && policy === "automatic")) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && style.contentVisibility !== 'hidden');
}
export function isReadableText(node: Text): boolean {
  let element: Element | null = node.parentElement;
  while (element) {
    if (!isReadableElement(element, true, "selection")) return false;
    element = element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
  }
  return true;
}
export async function yieldToPage(): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
