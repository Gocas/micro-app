import type {
  microAppWindowType,
  MicroLocation,
  SandBoxStartParams,
  CommonIframeEffect,
  SandBoxStopParams,
} from '@micro-app/types'
import {
  getEffectivePath,
  removeDomScope,
  rawDefineProperty,
  pureCreateElement,
  assign,
  clearDOM,
  CompletionPath,
  isScriptElement,
} from '../../libs/utils'
import {
  EventCenterForMicroApp,
  rebuildDataCenterSnapshot,
  recordDataCenterSnapshot,
} from '../../interact'
import globalEnv from '../../libs/global_env'
import {
  patchIframeRoute,
  initMicroLocation,
} from './route'
import {
  router,
  initRouteStateWithURL,
  clearRouteStateFromURL,
  addHistoryListener,
  removeStateAndPathFromBrowser,
  updateBrowserURLWithLocation,
} from '../router'
import {
  createMicroLocation,
} from '../router/location'
import bindFunctionToRawTarget from '../bind_function'
import {
  globalPropertyList,
} from './special_key'
import {
  reWriteElementInfo,
} from './actions'
import { appInstanceMap } from '../../create_app'
import {
  patchElementPrototypeMethods,
  releasePatches,
} from '../../source/patch'
import {
  patchIframeWindow
} from './window'
import {
  patchIframeDocument
} from './document'
import microApp from '../../micro_app'

export default class IframeSandbox {
  static activeCount = 0 // number of active sandbox
  public sandboxReady!: Promise<void>
  public microAppWindow: microAppWindowType
  public proxyLocation!: MicroLocation
  public proxyWindow: WindowProxy & microAppWindowType
  public baseElement!: HTMLBaseElement
  public microHead!: HTMLHeadElement
  public microBody!: HTMLBodyElement
  private active = false
  private windowEffect!: CommonIframeEffect
  private documentEffect!: CommonIframeEffect
  private removeHistoryListener!: CallableFunction

  constructor (appName: string, url: string) {
    const rawLocation = globalEnv.rawWindow.location
    const browserHost = rawLocation.protocol + '//' + rawLocation.host

    const childStaticLocation = new URL(url) as MicroLocation
    const childHost = childStaticLocation.protocol + '//' + childStaticLocation.host
    const childFullPath = childStaticLocation.pathname + childStaticLocation.search + childStaticLocation.hash

    const iframe = pureCreateElement('iframe')
    const iframeAttrs: Record<string, string> = {
      src: browserHost,
      style: 'display: none',
      name: appName,
    }
    Object.keys(iframeAttrs).forEach((key) => iframe.setAttribute(key, iframeAttrs[key]))

    globalEnv.rawDocument.body.appendChild(iframe)

    this.microAppWindow = iframe.contentWindow

    // exec before initStaticGlobalKeys
    this.createProxyLocation(
      appName,
      url,
      this.microAppWindow,
      childStaticLocation,
      browserHost,
      childHost,
    )

    this.createProxyWindow(
      appName,
      this.microAppWindow,
    )

    this.initStaticGlobalKeys(appName, url)

    this.patchIframe(this.microAppWindow, (resolve: CallableFunction) => {
      this.createIframeTemplate(this.microAppWindow)
      this.createIframeBase(this.microAppWindow)
      patchIframeRoute(appName, this.microAppWindow)
      // exec after patchIframeRoute
      initMicroLocation(appName, this.microAppWindow, childFullPath)
      this.windowEffect = patchIframeWindow(appName, this.microAppWindow)
      this.documentEffect = patchIframeDocument(appName, this.microAppWindow, this.proxyLocation)
      this.patchIframeNode(appName, this.microAppWindow)
      this.patchIframeAttribute(appName, url, this.microAppWindow)
      resolve()
    })
  }

  public start ({
    umdMode,
    baseroute,
    useMemoryRouter,
    defaultPage,
    disablePatchRequest,
  }: SandBoxStartParams) {
    if (!this.active) {
      this.active = true
      if (useMemoryRouter) {
        this.initRouteState(defaultPage)
        // unique listener of popstate event for sub app
        this.removeHistoryListener = addHistoryListener(
          this.microAppWindow.__MICRO_APP_NAME__,
        )
      } else {
        this.microAppWindow.__MICRO_APP_BASE_ROUTE__ = this.microAppWindow.__MICRO_APP_BASE_URL__ = baseroute
      }
      // TODO: 两种沙箱同时存在 activeCount 计数有问题，改为统一记录
      if (++IframeSandbox.activeCount === 1) {
        patchElementPrototypeMethods()
      }
    }
  }

  public stop ({
    umdMode,
    keepRouteState,
    clearEventSource,
    clearData,
  }: SandBoxStopParams) {
    if (this.active) {
      // clear global event, timeout, data listener
      this.releaseGlobalEffect(clearData)

      if (this.removeHistoryListener) {
        this.clearRouteState(keepRouteState)
        // release listener of popstate
        this.removeHistoryListener()
      }

      if (--IframeSandbox.activeCount === 0) {
        releasePatches()
      }

      this.active = false
    }
  }

  /**
   * clear global event, timeout, data listener
   * Scenes:
   * 1. unmount of normal/umd app
   * 2. hidden keep-alive app
   * 3. after init prerender app
   * @param clearData clear data from base app
   */
  public releaseGlobalEffect (clearData = false): void {
    this.windowEffect.release()
    this.documentEffect.release()
    this.microAppWindow.microApp.clearDataListener()
    this.microAppWindow.microApp.clearGlobalDataListener()
    if (clearData) {
      microApp.clearData(this.microAppWindow.__MICRO_APP_NAME__)
      this.microAppWindow.microApp.clearData()
    }
  }

  /**
   * record umd snapshot before the first execution of umdHookMount
   * Scenes:
   * 1. exec umdMountHook in umd mode
   * 2. hidden keep-alive app
   * 3. after init prerender app
   */
  public recordEffectSnapshot (): void {
    this.windowEffect.record()
    this.documentEffect.record()
    recordDataCenterSnapshot(this.microAppWindow.microApp)
  }

  // rebuild umd snapshot before remount umd app
  public rebuildEffectSnapshot (): void {
    this.windowEffect.rebuild()
    this.documentEffect.rebuild()
    rebuildDataCenterSnapshot(this.microAppWindow.microApp)
  }

  // set __MICRO_APP_PRE_RENDER__ state
  public setPreRenderState (state: boolean): void {
    this.microAppWindow.__MICRO_APP_PRE_RENDER__ = state
  }

  private initStaticGlobalKeys (appName: string, url: string): void {
    this.microAppWindow.__MICRO_APP_ENVIRONMENT__ = true
    this.microAppWindow.__MICRO_APP_NAME__ = appName
    this.microAppWindow.__MICRO_APP_URL__ = url
    this.microAppWindow.__MICRO_APP_PUBLIC_PATH__ = getEffectivePath(url)
    this.microAppWindow.__MICRO_APP_WINDOW__ = this.microAppWindow
    this.microAppWindow.__MICRO_APP_PRE_RENDER__ = false
    this.microAppWindow.__MICRO_APP_SANDBOX__ = this
    this.microAppWindow.rawWindow = globalEnv.rawWindow
    this.microAppWindow.rawDocument = globalEnv.rawDocument
    this.microAppWindow.microApp = assign(new EventCenterForMicroApp(appName), {
      removeDomScope,
      pureCreateElement,
      location: this.proxyLocation,
      router,
    })
  }

  // TODO: RESTRUCTURE
  private patchIframe (microAppWindow: microAppWindowType, cb: CallableFunction): void {
    this.sandboxReady = new Promise<void>((resolve) => {
      (function iframeLocationReady () {
        setTimeout(() => {
          if (microAppWindow.location.href === 'about:blank') {
            iframeLocationReady()
          } else {
            microAppWindow.stop()
            cb(resolve)
          }
        }, 0)
      })()
    })
  }

  // TODO: RESTRUCTURE
  private createIframeTemplate (microAppWindow: microAppWindowType): void {
    const microDocument = microAppWindow.document
    clearDOM(microDocument)
    const html = microDocument.createElement('html')
    html.innerHTML = '<head></head><body></body>'
    microDocument.appendChild(html)

    // 记录iframe原生body
    this.microBody = microDocument.body
    this.microHead = microDocument.head
  }

  private createIframeBase (microAppWindow: microAppWindowType): void {
    const microDocument = microAppWindow.document
    this.baseElement = microDocument.createElement('base')
    this.updateIframeBase()
    microDocument.head.appendChild(this.baseElement)
  }

  // 初始化和每次跳转时都要更新base的href
  public updateIframeBase = () => {
    this.baseElement.setAttribute('href', this.proxyLocation.protocol + '//' + this.proxyLocation.host + this.proxyLocation.pathname)
  }

  private createProxyLocation (
    appName: string,
    url: string,
    microAppWindow: microAppWindowType,
    childStaticLocation: MicroLocation,
    browserHost: string,
    childHost: string,
  ): void {
    this.proxyLocation = createMicroLocation(
      appName,
      url,
      microAppWindow,
      childStaticLocation,
      browserHost,
      childHost,
    )
  }

  private createProxyWindow (appName: string, microAppWindow: microAppWindowType): void {
    this.proxyWindow = new Proxy(microAppWindow, {
      get: (target: microAppWindowType, key: PropertyKey): unknown => {
        if (key === 'location') {
          return this.proxyLocation
        }

        if (globalPropertyList.includes(key.toString())) {
          return this.proxyWindow
        }

        return bindFunctionToRawTarget(Reflect.get(target, key), target)
      },
      set: (target: microAppWindowType, key: PropertyKey, value: unknown): boolean => {
        /**
         * TODO:
         * 1、location域名相同，子应用内部跳转时的处理
         * 2、和with沙箱的变量相同，提取成公共数组
         */
        if (key === 'location') {
          return Reflect.set(globalEnv.rawWindow, key, value)
        }
        Reflect.set(target, key, value)
        return true
      },
      has: (target: microAppWindowType, key: PropertyKey) => key in target,
    })
  }

  private patchIframeNode (appName: string, microAppWindow: microAppWindowType): void {
    const microDocument = microAppWindow.document
    const rawDocument = globalEnv.rawDocument
    const microRootNode = microAppWindow.Node
    const rawMicroGetRootNode = microRootNode.prototype.getRootNode
    const rawMicroAppendChild = microRootNode.prototype.appendChild
    const rawMicroInsertBefore = microRootNode.prototype.insertBefore
    const rawMicroReplaceChild = microRootNode.prototype.replaceChild

    const getRawTarget = (target: Node): Node => {
      if (target === this.microHead) {
        return rawDocument.head
      } else if (target === this.microBody) {
        return rawDocument.body
      }

      return target
    }

    microRootNode.prototype.getRootNode = function getRootNode (options?: GetRootNodeOptions): Node {
      const rootNode = rawMicroGetRootNode.call(this, options)
      // TODO: 只有shadowDOM才有效，非情shadowDOM直接指向document
      if (rootNode === appInstanceMap.get(appName)?.container) return microAppWindow.document
      return rootNode
    }

    microRootNode.prototype.appendChild = function appendChild <T extends Node> (node: T): T {
      reWriteElementInfo(node, microAppWindow, appName)
      // TODO：只有script才可以这样拦截，link、style不应该拦截
      if (isScriptElement(node) && node.__PURE_ELEMENT__) {
        return rawMicroAppendChild.call(this, node)
      }
      const _this = getRawTarget(this)
      if (_this !== this) {
        return _this.appendChild(node)
      }
      return rawMicroAppendChild.call(_this, node)
    }

    // TODO: 更多场景适配
    microRootNode.prototype.insertBefore = function insertBefore <T extends Node> (node: T, child: Node | null): T {
      reWriteElementInfo(node, microAppWindow, appName)
      // console.log(6666666, node)
      if (isScriptElement(node) && node.__PURE_ELEMENT__) {
        return rawMicroInsertBefore.call(this, node, child)
      }
      const _this = getRawTarget(this)
      if (_this !== this) {
        if (child && !_this.contains(child)) {
          return _this.appendChild(node)
        }
        return _this.insertBefore(node, child)
      }
      return rawMicroInsertBefore.call(_this, node, child)
    }

    // TODO: 更多场景适配
    microRootNode.prototype.replaceChild = function replaceChild <T extends Node> (node: Node, child: T): T {
      reWriteElementInfo(node, microAppWindow, appName)
      if (isScriptElement(node) && node.__PURE_ELEMENT__) {
        return rawMicroReplaceChild.call(this, node, child)
      }
      const _this = getRawTarget(this)
      if (_this !== this) {
        if (child && !_this.contains(child)) {
          _this.appendChild(node) as T
          return child
        }
        return _this.replaceChild(node, child)
      }
      return rawMicroReplaceChild.call(_this, node, child)
    }

    /**
     * TODO:
     * 1、append prepend
     * 2、cloneNode
     * 3、innerHTML
     * 4、querySelector、querySelectorAll (head, body)
     * 5、Image
     * 都是Element原型链上的方法
     */
  }

  private patchIframeAttribute (appName: string, url: string, microAppWindow: microAppWindowType): void {
    const microRootElement = microAppWindow.Element
    const rawMicroSetAttribute = microRootElement.prototype.setAttribute

    microRootElement.prototype.setAttribute = function setAttribute (key: string, value: any): void {
      if (
        ((key === 'src' || key === 'srcset') && /^(img|script)$/i.test(this.tagName)) ||
        (key === 'href' && /^link$/i.test(this.tagName))
      ) {
        value = CompletionPath(value, url)
      }

      rawMicroSetAttribute.call(this, key, value)
    }

    const protoAttrList: Array<[HTMLElement, string]> = [
      [microAppWindow.HTMLImageElement.prototype, 'src'],
      [microAppWindow.HTMLScriptElement.prototype, 'src'],
      [microAppWindow.HTMLLinkElement.prototype, 'href'],
    ]

    protoAttrList.forEach(([target, attr]) => {
      const { enumerable, configurable, get, set } = Object.getOwnPropertyDescriptor(target, attr) || {
        enumerable: true,
        configurable: true,
      }

      rawDefineProperty(target, attr, {
        enumerable,
        configurable,
        get: function () {
          return get?.call(this)
        },
        set: function (value) {
          set?.call(this, CompletionPath(value, url))
        },
      })
    })
  }

  private initRouteState (defaultPage: string): void {
    initRouteStateWithURL(
      this.microAppWindow.__MICRO_APP_NAME__,
      this.microAppWindow.location as MicroLocation,
      defaultPage,
    )
  }

  private clearRouteState (keepRouteState: boolean): void {
    clearRouteStateFromURL(
      this.microAppWindow.__MICRO_APP_NAME__,
      this.microAppWindow.__MICRO_APP_URL__,
      this.microAppWindow.location as MicroLocation,
      keepRouteState,
    )
  }

  public setRouteInfoForKeepAliveApp (): void {
    updateBrowserURLWithLocation(
      this.microAppWindow.__MICRO_APP_NAME__,
      this.microAppWindow.location as MicroLocation,
    )
  }

  public removeRouteInfoForKeepAliveApp (): void {
    removeStateAndPathFromBrowser(this.microAppWindow.__MICRO_APP_NAME__)
  }
}
