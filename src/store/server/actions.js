import types from 'src/store/server/types'
import api from 'src/utils/api'
import { Notify, Dialog, Loading, QSpinnerGears } from 'quasar'
import helper from 'src/utils/helper'
import { i18n } from 'boot/i18n'
import bus from 'components/bus'
import events from 'src/constants/events'
import ClientFileStorage from 'src/utils/storage/ClientFileStorage'
import ServerFileStorage from 'src/utils/storage/ServerFileStorage'
import _ from 'lodash'
import FormData from 'form-data'
import { exportMarkdownFile, exportMarkdownFiles } from 'src/ApiHandler'

export async function _getContent (kbGuid, docGuid) {
  const { info } = await api.KnowledgeBaseApi.getNoteContent({
    kbGuid,
    docGuid,
    data: {
      downloadInfo: 1
    }
  })
  // dataModified
  const cacheKey = api.KnowledgeBaseApi.getCacheKey(kbGuid, docGuid)
  const note = ClientFileStorage.getCachedNote(info, cacheKey)
  let result
  if (!helper.isNullOrEmpty(note)) {
    result = note
  } else {
    result = await api.KnowledgeBaseApi.getNoteContent({
      kbGuid,
      docGuid,
      data: {
        downloadInfo: 1,
        downloadData: 1
      }
    })
    ClientFileStorage.setCachedNote(result, cacheKey)
  }
  return result
}

export default {
  /**
   * 从本地缓存中读取数据，初始化状态树
   * @param commit
   * @param state
   */
  async initServerStore ({ commit, state }) {
    const localStore = ClientFileStorage.getItemsFromStore(state)
    commit(types.INIT, localStore)
    ServerFileStorage.removeItemFromLocalStorage('token')
    const [
      autoLogin,
      userId,
      password,
      url
    ] = ClientFileStorage.getItemsFromStore([
      'autoLogin',
      'userId',
      'password',
      'url'
    ])
    if (autoLogin) {
      await this.dispatch('server/login', { userId, password, url })
    }
  },
  async getContent (payload, { kbGuid, docGuid }) {
    return await _getContent(kbGuid, docGuid)
  },
  /**
   * 用户登录接口
   * @param commit
   * @param rootState
   * @param payload
   * @returns {Promise<*>}
   */
  async login ({ commit, rootState }, payload) {
    const { url } = payload
    api.AccountServerApi.setBaseUrl(url)
    const { userId, password } = payload
    const result = await api.AccountServerApi.Login(payload)

    if (rootState.client.rememberPassword) {
      ClientFileStorage.setItemsInStore({ userId, password, url })
    } else {
      if (ClientFileStorage.isKeyExistInStore('password')) {
        ClientFileStorage.removeItemFromStore('password')
      }
      ClientFileStorage.setItemsInStore({ userId, url })
    }
    if (
      !rootState.client.enableSelfHostServer &&
      ClientFileStorage.isKeyExistInStore('url')
    ) {
      ClientFileStorage.removeItemFromStore('url')
    }

    commit(types.LOGIN, { ...result, isLogin: true })
    await this.dispatch('server/getAllTags')
    this.dispatch('server/getAllCategories')
    this.dispatch('server/getCategoryNotes')

    return result
  },
  /**
   * 登出
   * @param commit
   * @returns {Promise<void>}
   */
  async logout ({ commit }) {
    await api.AccountServerApi.Logout()
    ServerFileStorage.removeItemFromLocalStorage('token')
    commit(types.LOGOUT)
  },
  /**
   * 重新登录
   * @param commit
   * @returns {Promise<void>}
   */
  async reLogin ({ commit }) {
    const [userId, password, url] = ClientFileStorage.getItemsFromStore([
      'userId',
      'password',
      'url'
    ])
    await this.dispatch('server/login', {
      userId,
      password,
      url
    })
  },
  /**
   * 获取指定文件夹下的笔记
   * @param commit
   * @param state
   * @param payload
   * @returns {Promise<void>}
   */
  async getCategoryNotes ({ commit, state }, payload = {}) {
    const { kbGuid, currentCategory, tags } = state
    const { category, start, count } = payload
    const isTagCategory = tags.map(t => t.tagGuid).includes(helper.isNullOrEmpty(category) ? currentCategory : category)
    if (isTagCategory) {
      this.dispatch('server/getTagNotes', { tag: currentCategory })
      return
    }
    commit(types.UPDATE_CURRENT_NOTES_LOADING_STATE, true)
    const result = await api.KnowledgeBaseApi.getCategoryNotes({
      kbGuid,
      data: {
        category: category || currentCategory,
        start: start || 0,
        count: count || 100,
        withAbstract: true
      }
    })
    commit(types.UPDATE_CURRENT_NOTES_LOADING_STATE, false)
    commit(types.UPDATE_CURRENT_NOTES, result)
  },
  /**
   * 获取所有的笔记
   * @param commit
   * @param state
   * @returns {Promise<void>}
   */
  async getAllCategories ({ commit, state }) {
    commit(types.UPDATE_CURRENT_NOTES_LOADING_STATE, true)
    const { kbGuid } = state
    const result = await api.KnowledgeBaseApi.getCategories({ kbGuid })
    commit(types.UPDATE_ALL_CATEGORIES, result)
    commit(types.UPDATE_CURRENT_NOTES_LOADING_STATE, false)
  },
  /**
   * 获取笔记内容
   * @param commit
   * @param state
   * @param payload
   * @returns {Promise<void>}
   */
  async getNoteContent ({ commit, state }, payload) {
    commit(types.UPDATE_CURRENT_NOTE_LOADING_STATE, true)
    const { kbGuid } = state
    const { docGuid } = payload
    const result = await _getContent(kbGuid, docGuid)

    commit(types.UPDATE_CURRENT_NOTE, result)
    commit(types.UPDATE_CURRENT_NOTE_LOADING_STATE, false)
  },
  /**
   * 设置当前显示的笔记文件夹，并在显示之前从网络刷新文件夹的内容
   * @param commit
   * @param category
   * @returns {Promise<void>}
   */
  async updateCurrentCategory ({ commit }, payload) {
    const { type, data } = payload
    if (type === 'category') {
      await this.dispatch('server/getCategoryNotes', { category: data })
    } else if (type === 'tag') {
      await this.dispatch('server/getTagNotes', { tag: data })
    } else {
      await this.dispatch('server/getCategoryNotes', { category: '' })
    }
    commit(types.UPDATE_CURRENT_CATEGORY, data)
    commit(types.SAVE_TO_LOCAL_STORE_SYNC, ['currentCategory', data])
  },
  /**
   * 更新笔记信息，例如笔记title等
   * @param commit
   * @param state
   * @param payload
   * @returns {Promise<void>}
   */
  async updateNoteInfo ({ commit, state }, payload) {
    const { docGuid, kbGuid } = payload
    await api.KnowledgeBaseApi.updateNoteInfo({
      kbGuid,
      docGuid,
      data: payload
    })
    this.dispatch('server/getCategoryNotes')
  },
  /**
   * 更新笔记内容
   * @param commit
   * @param state
   * @param markdown
   * @returns {Promise<void>}
   */
  async updateNote ({ commit, state }, markdown) {
    const { kbGuid, docGuid, category } = state.currentNote.info
    let { title } = state.currentNote.info
    const { resources } = state.currentNote
    const isLite = category.replace(/\//g, '') === 'Lite'
    const html = helper.embedMDNote(markdown, resources, {
      wrapWithPreTag: isLite
    })

    const _updateNote = async title => {
      const result = await api.KnowledgeBaseApi.updateNote({
        kbGuid,
        docGuid,
        data: {
          html,
          title,
          kbGuid,
          docGuid,
          category,
          resources: resources.map(r => r.name),
          type: isLite ? 'lite/markdown' : 'document'
        }
      })

      ClientFileStorage.setCachedNote(
        { info: result, html },
        api.KnowledgeBaseApi.getCacheKey(kbGuid, docGuid),
        null
      )
      Notify.create({
        color: 'primary',
        message: i18n.t('saveNoteSuccessfully'),
        icon: 'check'
      })
      await this.dispatch('server/getCategoryNotes')
      commit(types.UPDATE_CURRENT_NOTE, result)
    }
    if (!_.endsWith(title, '.md')) {
      Dialog.create({
        title: i18n.t('convertToMarkdownNote'),
        message: i18n.t('convertToMarkdownNoteHint'),
        ok: {
          label: i18n.t('ok')
        },
        cancel: {
          label: i18n.t('cancel')
        }
      }).onOk(async () => {
        title = `${title}.md`
        await _updateNote(title)
      })
    } else {
      await _updateNote(title)
    }
  },
  /**
   * 创建笔记
   * @param commit
   * @param state
   * @param rootState
   * @param title
   * @returns {Promise<void>}
   */
  async createNote ({ commit, state, rootState }, title) {
    const { kbGuid, currentCategory = '' } = state
    const userId = ClientFileStorage.getItemFromStore('userId')
    const isLite = currentCategory.replace(/\//g, '') === 'Lite'
    const result = await api.KnowledgeBaseApi.createNote({
      kbGuid,
      data: {
        category: currentCategory,
        kbGuid,
        title,
        owner: userId,
        html: helper.embedMDNote(`# ${title}`, [], { wrapWithPreTag: isLite }),
        type: isLite ? 'lite/markdown' : 'document'
      }
    })
    await this.dispatch('server/getNoteContent', result)
    await this.dispatch('server/getCategoryNotes')
    // if (/\.md$/.test(title) && rootState.client.markdownOnly) {
    //   commit(types.js.UPDATE_CURRENT_NOTE, result)
    // }
  },
  /**
   * 删除笔记
   * @param commit
   * @param state
   * @param payload
   * @returns {Promise<void>}
   */
  async deleteNote ({ commit, state }, payload) {
    const { kbGuid, docGuid } = payload
    await api.KnowledgeBaseApi.deleteNote({ kbGuid, docGuid })
    const { currentNote } = state
    if (currentNote && currentNote.info.docGuid === docGuid) {
      commit(types.CLEAR_CURRENT_NOTE)
    }
    await this.dispatch('server/getCategoryNotes')
    Notify.create({
      color: 'red-10',
      message: i18n.t('deleteNoteSuccessfully'),
      icon: 'delete'
    })
  },
  /**
   * 创建笔记目录
   * @param commit
   * @param state
   * @param childCategoryName
   * @returns {Promise<void>}
   */
  async createCategory ({ commit, state }, childCategoryName) {
    const { kbGuid, currentCategory } = state
    await api.KnowledgeBaseApi.createCategory({
      kbGuid,
      data: {
        parent: helper.isNullOrEmpty(currentCategory) ? '/' : currentCategory,
        pos: Math.floor(Date.now() / 1000).toFixed(0),
        child: childCategoryName
      }
    })
    await this.dispatch('server/getAllCategories')
    await this.dispatch(
      'server/updateCurrentCategory',
      helper.isNullOrEmpty(currentCategory)
        ? `/${childCategoryName}/`
        : `${currentCategory}${childCategoryName}/`
    )
  },
  async deleteCategory ({ commit, state }, category) {
    const { kbGuid } = state
    await api.KnowledgeBaseApi.deleteCategory({ kbGuid, data: { category } })
    await this.dispatch('server/getAllCategories')
    await this.dispatch('server/updateCurrentCategory', '')
    Notify.create({
      color: 'red-10',
      message: i18n.t('deleteCategorySuccessfully'),
      icon: 'delete'
    })
  },
  async uploadImage ({ commit, getters, state, rootState }, file) {
    // TODO: 实现图片上传
    const token = getters.wizNoteToken
    const {
      kbGuid,
      currentNote: {
        info: { docGuid }
      }
    } = state

    const formData = new FormData()
    const {
      client: {
        imageUploadService,
        apiServerUrl,
        postParam,
        jsonPath,
        customHeader,
        customBody
      }
    } = rootState

    let data = {},
      options = {}
    switch (imageUploadService) {
      case 'wizOfficialImageUploadService':
        formData.append('data', file)
        formData.append('kbGuid', kbGuid)
        formData.append('docGuid', docGuid)
        data = {
          kbGuid,
          docGuid,
          formData: formData,
          config: {
            headers: {
              'Content-Type': 'multipart/form-data',
              'X-Wiz-Token': token
            }
          }
        }
        break
      case 'smmsImageUploadService':
        data = file
        break
      case 'customWebUploadService':
        data = file
        options = {
          apiServerUrl,
          postParam,
          jsonPath,
          customHeader,
          customBody
        }
        break
      default:
        break
    }

    const result = await api.UploadImageApi(imageUploadService, data, options)
    if (result) {
      bus.$emit(
        events.INSERT_IMAGE,
        getters.imageUrl(result, imageUploadService)
      )
    }
    if (imageUploadService === 'wizOfficialImageUploadService') {
      commit(types.UPDATE_CURRENT_NOTE_RESOURCE, result)
    }
  },
  async moveNote ({ commit }, noteInfo) {
    const { kbGuid, docGuid, category, type } = noteInfo
    const isLite = category === '/Lite/' ? 'lite/markdown' : type
    await api.KnowledgeBaseApi.updateNoteInfo({
      kbGuid,
      docGuid,
      data: { ...noteInfo, type: isLite ? 'lite/markdown' : type }
    })
    await this.dispatch('server/getCategoryNotes')
  },
  async copyNote ({ commit, state }, noteInfo) {
    const { kbGuid, docGuid, category, title, type } = noteInfo
    const { currentCategory } = state
    const userId = ClientFileStorage.getItemFromStore('userId')

    const noteContent = await api.KnowledgeBaseApi.getNoteContent({
      kbGuid,
      docGuid,
      data: {
        downloadInfo: 1,
        downloadData: 1
      }
    })
    const { html } = noteContent
    const isCurrentCategory = category === noteContent.info.category
    await api.KnowledgeBaseApi.createNote({
      kbGuid,
      data: {
        category: category,
        kbGuid,
        title: isCurrentCategory
          ? `${title.replace(/\.md/, '')}-${i18n.t('duplicate')}${
              title.indexOf('.md') !== -1 ? '.md' : ''
            }`
          : title,
        owner: userId,
        html,
        type: category === '/Lite/' ? 'lite/markdown' : type
      }
    })
    if (isCurrentCategory || helper.isNullOrEmpty(currentCategory)) {
      await this.dispatch('server/getCategoryNotes')
    }
  },
  async searchNote ({ commit, state }, searchText) {
    const { kbGuid } = state
    commit(types.UPDATE_CURRENT_NOTES_LOADING_STATE, true)
    const result = await api.KnowledgeBaseApi.searchNote({
      data: {
        ss: searchText
      },
      kbGuid
    })
    commit(types.UPDATE_CURRENT_NOTES, result)
    commit(types.UPDATE_CURRENT_NOTES_LOADING_STATE, false)
  },
  async updateContentsList ({ commit }, editorRootElement) {
    const list = await helper.updateContentsList(editorRootElement) || []
    commit(types.UPDATE_CONTENTS_LIST, list)
  },
  updateNoteState ({ commit }, noteState) {
    commit(types.UPDATE_NOTE_STATE, noteState)
  },
  async getTagNotes ({ commit, state }, payload) {
    commit(types.UPDATE_CURRENT_NOTES_LOADING_STATE, true)
    const { kbGuid } = state
    const { tag, start, count } = payload
    const result = await api.KnowledgeBaseApi.getTagNotes({
      kbGuid,
      data: {
        tag,
        withAbstract: true,
        start: start || 0,
        count: count || 100,
        orderBy: 'modified'
      }
    })
    commit(types.UPDATE_CURRENT_NOTES_LOADING_STATE, false)
    commit(types.UPDATE_CURRENT_NOTES, result)
  },
  async getAllTags ({ commit, state }) {
    const { kbGuid } = state
    const tags = await api.KnowledgeBaseApi.getAllTags({ kbGuid })
    commit(types.UPDATE_ALL_TAGS, tags)
  },
  /**
   * 创建一个标签，但没有指定哪篇笔记拥有这个标签
   * @param state
   * @param parentTag
   * @param name
   * @returns {Promise<void>}
   */
  async createTag ({ state }, { parentTag = {}, name }) {
    const { kbGuid } = state
    const { tagGuid: parentTagGuid } = parentTag
    return await api.KnowledgeBaseApi.createTag({
      kbGuid,
      data: {
        parentTagGuid,
        name
      }
    })
  },
  /**
   * 将指定的标签添加到当前笔记上
   * @param state
   * @param commit
   * @param tagGuid
   * @returns {Promise<void>}
   */
  async attachTag ({ state, commit }, { tagGuid }) {
    const {
      currentNote: { info }
    } = state
    const newTagList = info.tags?.split('*') || []
    newTagList.push(tagGuid)
    commit(types.UPDATE_CURRENT_NOTE_TAGS, newTagList.join('*'))
    this.dispatch('server/updateNoteInfo', {
      ...state.currentNote.info,
      tags: newTagList.join('*')
    })
    this.dispatch('server/getAllTags')
  },
  async renameTag ({ state }, tag) {
    const { kbGuid } = state
    const { tagGuid, name } = tag
    await api.KnowledgeBaseApi.renameTag({ kbGuid, data: { tagGuid, name } })
    this.dispatch('server/getAllTags')
  },
  async moveTag ({ state }, { tag, parentTag = {} }) {
    const { kbGuid } = state
    const { tagGuid } = tag
    const { tagGuid: parentTagGuid } = parentTag
    await api.KnowledgeBaseApi.moveTag({
      kbGuid,
      data: { tagGuid, parentTagGuid }
    })
    this.dispatch('server/getAllTags')
  },
  /**
   * 移除某篇笔记上的tag标记，不会删除这个tag
   * @returns {Promise<void>}
   */
  async removeTag ({ state, commit }, { tagGuid }) {
    const {
      currentNote: { info }
    } = state
    const newTagList =
      info.tags?.split('*').filter(t => t !== tagGuid) || []
    commit(types.UPDATE_CURRENT_NOTE_TAGS, newTagList.join('*'))
    this.dispatch('server/updateNoteInfo', {
      ...state.currentNote.info,
      tags: newTagList.join('*')
    })
    this.dispatch('server/getAllTags')
  },
  /**
   * 将一个tag永久删除
   * @param state
   * @param tag
   * @returns {Promise<void>}
   */
  async deleteTag ({ state }, tag) {
    const { kbGuid } = state
    const { tagGuid } = tag
    await api.KnowledgeBaseApi.deleteTag({ kbGuid, tagGuid })
    this.dispatch('server/getAllTags')
  },
  /**
   * 导出markdown文件到本地
   * @param state
   * @param noteField
   * @returns {Promise<void>}
   */
  async exportMarkdownFile ({ state }, noteField) {
    const { kbGuid } = state
    const { docGuid } = noteField
    const result = await _getContent(kbGuid, docGuid)
    const isHtml = !_.endsWith(result.info.title, '.md')
    const { html, resources } = result
    let content
    if (isHtml) {
      content = helper.convertHtml2Markdown(html, kbGuid, docGuid, resources)
    } else {
      content = helper.extractMarkdownFromMDNote(
        html,
        kbGuid,
        docGuid,
        resources
      )
    }
    await exportMarkdownFile(content)
    Notify.create({
      color: 'primary',
      message: i18n.t('exportNoteSuccessfully'),
      icon: 'check'
    })
  },
  /**
   * 批量导出markdown笔记到本地
   * @param state
   * @param noteFields
   * @returns {Promise<void>}
   */
  async exportMarkdownFiles ({ state }, noteFields = []) {
    const { kbGuid } = state
    const results = []
    Loading.show({
      spinner: QSpinnerGears,
      message: i18n.t('prepareExportData')
    })
    for (const noteField of noteFields) {
      const { docGuid } = noteField
      const result = await _getContent(kbGuid, docGuid)
      results.push(result)
    }
    const contents = results.map(result => {
      const isHtml = !_.endsWith(result.info.title, '.md')
      const {
        html,
        info: { docGuid },
        resources
      } = result
      let content
      if (isHtml) {
        content = helper.convertHtml2Markdown(html, kbGuid, docGuid, resources)
      } else {
        content = helper.extractMarkdownFromMDNote(
          html,
          kbGuid,
          docGuid,
          resources
        )
      }
      return {
        content,
        title: isHtml ? result.info.title : result.info.title.replace('.md', '')
      }
    })
    Loading.hide()
    await exportMarkdownFiles(contents)
    Notify.create({
      color: 'primary',
      message: i18n.t('exportNoteSuccessfully'),
      icon: 'check'
    })
  }
}
