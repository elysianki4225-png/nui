// 固定行高虚拟视图：仅渲染可视窗口 +  overscan，DOM 节点回收复用。
// 支持列表（columns=1）与网格（columns=N）。十万级数据依然流畅。
import { rafThrottle } from './core.js';

export class VirtualView {
  constructor(container, { rowHeight = 84, columns = 1, gap = 0, overscan = 4, renderRow, onScroll } = {}) {
    this.container = container;
    this.rowHeight = rowHeight;
    this.columns = columns;
    this.gap = gap;
    this.overscan = overscan;
    this.renderRow = renderRow;
    this.onScroll = onScroll;
    this.items = [];
    this.rendered = new Map(); // rowIndex -> wrapper el
    this.destroyed = false;

    this.content = document.createElement('div');
    this.content.style.cssText = 'position:relative;width:100%;';
    this.container.style.overflowY = 'auto';
    this.container.style.position = 'relative';
    this.container.append(this.content);

    this._onScroll = rafThrottle(() => { this.render(); this.onScroll?.(); });
    this.container.addEventListener('scroll', this._onScroll, { passive: true });
    this._onResize = rafThrottle(() => this.render());
    this.resizeObserver = new ResizeObserver(this._onResize);
    this.resizeObserver.observe(this.container);
  }

  get totalRows() { return Math.ceil(this.items.length / this.columns); }

  setItems(items, { keepScroll = false } = {}) {
    this.items = items;
    if (!keepScroll) this.container.scrollTop = 0;
    this.refresh();
  }

  setColumns(n) { if (n !== this.columns) { this.columns = n; this.refresh(); } }
  setRowHeight(h) { if (h !== this.rowHeight) { this.rowHeight = h; this.refresh(); } }

  refresh() {
    // 清空已渲染（数据变化时）
    for (const [, el] of this.rendered) el.remove();
    this.rendered.clear();
    this.content.style.height = `${this.totalRows * this.rowHeight}px`;
    this.render();
  }

  render() {
    if (this.destroyed) return;
    const { scrollTop, clientHeight } = this.container;
    const total = this.totalRows;
    this.content.style.height = `${total * this.rowHeight}px`;
    if (!total) {
      for (const [, el] of this.rendered) el.remove();
      this.rendered.clear();
      return;
    }
    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.overscan);
    const end = Math.min(total, Math.ceil((scrollTop + clientHeight) / this.rowHeight) + this.overscan);
    // 移除窗口外
    for (const [idx, el] of this.rendered) {
      if (idx < start || idx >= end) { el.remove(); this.rendered.delete(idx); }
    }
    // 新增窗口内
    const frag = document.createDocumentFragment();
    for (let row = start; row < end; row++) {
      if (this.rendered.has(row)) continue;
      const startIdx = row * this.columns;
      const rowItems = this.items.slice(startIdx, startIdx + this.columns);
      const wrapper = document.createElement('div');
      wrapper.style.cssText = `position:absolute;top:${row * this.rowHeight}px;left:0;right:0;height:${this.rowHeight}px;`;
      const inner = this.renderRow(rowItems, startIdx);
      if (inner) wrapper.append(inner);
      this.rendered.set(row, wrapper);
      frag.append(wrapper);
    }
    if (frag.childNodes.length) this.content.append(frag);
  }

  scrollToTop() { this.container.scrollTop = 0; }

  destroy() {
    this.destroyed = true;
    this.container.removeEventListener('scroll', this._onScroll);
    this.resizeObserver.disconnect();
    for (const [, el] of this.rendered) el.remove();
    this.rendered.clear();
    this.content.remove();
    this.items = [];
  }
}
