import type { Disposable, ViewContainerContribution, ViewContribution, ViewProvider } from "../extensions/api";
import { disposable, h } from "./dom";

interface ViewState {
  contribution: ViewContribution;
  provider?: ViewProvider;
  body: HTMLElement;
  actions: HTMLElement;
  rendered?: void | Disposable;
  collapsed: boolean;
}

/** Activity bar + side bar. Containers and views come from manifests;
 *  providers are attached when their extension activates. */
export class ViewService {
  readonly activityBar = h("div.activitybar");
  readonly sidebar = h("div.sidebar");
  private containers: ViewContainerContribution[] = [];
  private views = new Map<string, ViewState>();
  private active: string | null = null;
  activate: (event: string) => Promise<void> = async () => {};
  run: (command: string) => void = () => {};

  contributeContainer(c: ViewContainerContribution) {
    this.containers.push(c);
    this.containers.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    this.renderActivityBar();
  }

  contributeView(v: ViewContribution) {
    this.views.set(v.id, { contribution: v, body: h("div.view-body"), actions: h("div.view-actions"), collapsed: false });
    if (this.active === v.container) this.showContainer(v.container);
  }

  register(id: string, provider: ViewProvider): Disposable {
    const v = this.views.get(id);
    if (!v) throw new Error(`view ${id} is not declared in any extension manifest`);
    v.provider = provider;
    this.renderView(v);
    return disposable(() => {
      (v.rendered as Disposable | undefined)?.dispose?.();
      v.provider = undefined;
      v.body.replaceChildren();
    });
  }

  refresh(id: string) {
    const v = this.views.get(id);
    if (v) this.renderView(v);
  }

  toggleSidebar(show = this.sidebar.hidden) {
    this.sidebar.hidden = !show;
  }

  async showContainer(id: string) {
    if (this.active === id && !this.sidebar.hidden && this.sidebar.childElementCount) {
      this.renderActivityBar();
      return;
    }
    this.active = id;
    this.sidebar.hidden = false;
    const container = this.containers.find((c) => c.id === id);
    const views = [...this.views.values()].filter((v) => v.contribution.container === id);
    this.sidebar.replaceChildren(
      h("div.sidebar-title", {}, container?.title.toUpperCase() ?? id),
      ...views.map((v) => {
        const header = h(
          "div.view-header",
          { onclick: () => { v.collapsed = !v.collapsed; section.classList.toggle("collapsed", v.collapsed); } },
          h("span.twistie", {}, "▾"),
          h("span.view-title", {}, v.contribution.title.toUpperCase()),
          v.actions,
        );
        const section = h(`div.view-section${v.collapsed ? ".collapsed" : ""}`, {}, header, v.body);
        return section;
      }),
    );
    this.renderActivityBar();
    for (const v of views) {
      if (!v.provider) await this.activate(`onView:${v.contribution.id}`);
    }
  }

  private renderView(v: ViewState) {
    (v.rendered as Disposable | undefined)?.dispose?.();
    v.body.replaceChildren();
    v.actions.replaceChildren(
      ...(v.provider?.actions ?? []).map((a) =>
        h("button.icon-button", { title: a.title, onclick: (e: MouseEvent) => { e.stopPropagation(); this.run(a.command); } }, a.icon),
      ),
    );
    if (v.provider) {
      try {
        v.rendered = v.provider.render(v.body);
      } catch (e) {
        v.body.append(h("div.view-error", {}, `View failed: ${e}`));
      }
    }
  }

  private renderActivityBar() {
    this.activityBar.replaceChildren(
      ...this.containers.map((c) =>
        h(
          `button.activity${c.id === this.active && !this.sidebar.hidden ? ".active" : ""}`,
          {
            title: c.title,
            onclick: () => {
              if (c.id === this.active && !this.sidebar.hidden) {
                this.toggleSidebar(false);
                this.renderActivityBar();
              } else this.showContainer(c.id);
            },
          },
          c.icon,
        ),
      ),
    );
  }
}
