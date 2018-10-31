// @flow

import {blocksToEditorValue} from '@sanity/block-tools'
import {Selection, Text, Mark} from 'slate'
import {isEqual} from 'lodash'
import type {
  BlockContentFeatures,
  Path,
  SlateEditor,
  SlateNode,
  SlateValue,
  Type
} from '../typeDefs'
import type {
  Patch,
  SetPatch,
  DiffMatchPatch,
  InsertPatch,
  UnsetPatch,
  SetIfMissingPatch
} from '../../../typedefs/patch'

import apply, {applyAll} from '../../../simplePatch'
import findInlineByAnnotationKey from './findInlineByAnnotationKey'
import createSelectionOperation from './createSelectionOperation'
import createEditorController from './createEditorController'
import buildEditorSchema from './buildEditorSchema'

type JSONValue = number | string | boolean | {[string]: JSONValue} | JSONValue[]

function findLastKey(path: Path[]) {
  let key = null
  path.forEach(part => {
    if (part._key) {
      key = part._key
    }
  })
  return key
}

function findEditorChildNodeFromBlockChildKey(blockNode: SlateNode, childKey: Path) {
  let count = -1
  return blockNode.nodes.find(node => {
    if (node.object === 'text') {
      node.leaves.forEach((leaf, index) => {
        if (index > 0 && leaf.marks.subtract(node.leaves.get(index - 1)).size > 0) {
          count++
        }
      })
      count++
    } else {
      count++
    }
    return `${blockNode.key}${count}` === childKey
  })
}

export default function createPatchesToChange(
  blockContentFeatures: BlockContentFeatures,
  blockContentType: Type
) {
  const schema = buildEditorSchema(blockContentFeatures, {withNormalization: false})
  const controller = createEditorController({
    value: null,
    plugins: [{schema}]
  })

  function setPatch(patch: SetPatch, editor: SlateEditor) {
    if (Array.isArray(patch.value)) {
      if (patch.path.length === 0) {
        return replaceValue(patch.value, editor)
      }
      throw new Error(`Invalid patch, looks like it should be an insert: ${JSON.stringify(patch)}`)
    }
    const editorBlock = blocksToEditorValue([patch.value], blockContentType).document.nodes[0]
    const key = findLastKey(patch.path)
    editor.replaceNodeByKey(key, editorBlock)
    return editor.operations
  }

  function setIfMissingPatch(patch: SetIfMissingPatch, editor: SlateEditor) {
    if (patch.path.length === 0) {
      if (editor.value.document.nodes.size === 0) {
        return replaceValue(patch.value, editor)
      }
      return editor.operations
    }
    const doc = editor.value.document
    const blockKey = patch.path[0]._key
    const block = doc.nodes.find(node => node.key === blockKey)
    if (editor.query('isVoid', block)) {
      const data = block.data.toObject()
      if (!data.value) {
        const newData = {...data, value: patch.value}
        editor.setNodeByKey(blockKey, {data: newData})
      }
    }
    return editor.operations
  }

  function insertPatch(patch: InsertPatch, editor: SlateEditor) {
    const {items, position} = patch
    const blocksToInsert = blocksToEditorValue(items, blockContentType)
    const posKey = findLastKey(patch.path)
    let index = editor.value.document.nodes.findIndex((node, indx) => {
      return posKey ? node.key === posKey : indx === patch.path[0]
    })
    if (position === 'before') {
      index = index > 0 ? index-- : index
    }
    if (position === 'after') {
      index++
    }
    blocksToInsert.document.nodes.forEach(block => {
      editor.applyOperation({
        type: 'insert_node',
        path: [index++],
        node: block
      })
    })
    return editor.operations
  }

  function unsetPatch(patch: UnsetPatch, editor: SlateEditor) {
    const lastKey = findLastKey(patch.path)
    editor.removeNodeByKey(lastKey)
    return editor.operations
  }

  function replaceValue(snapshot: ?JSONValue, editor: SlateEditor) {
    // console.log('Replacing value')
    if (snapshot) {
      const fragment = blocksToEditorValue(snapshot, blockContentType)
      // Store the old selection
      const select = createSelectionOperation(editor)
      editor.value.document.nodes.forEach(node => {
        editor.applyOperation({
          type: 'remove_node',
          path: [0],
          node: node
        })
      })
      fragment.document.nodes.reverse().forEach(node => {
        editor.applyOperation({
          type: 'insert_node',
          path: [0],
          node: node
        })
      })
      // Restore the old selection
      editor.applyOperation(select)
      return editor.operations
    }
    throw new Error('No snapshot given!')
  }

  // eslint-disable-next-line complexity
  function patchAnnotationData(patch: Patch, editor: SlateEditor) {
    const doc = editor.value.document
    const markDefKey = patch.path[2]._key
    const node = findInlineByAnnotationKey(markDefKey, doc)

    const data = node.data.toObject()
    data.annotations = data.annotations || {}
    const annotationKey = Object.keys(data.annotations).find(
      key => data.annotations[key]._key === markDefKey
    )
    if (!annotationKey) {
      throw new Error('Annotation not found in data')
    }
    // If this is a unset patch, remove the annotation
    if (patch.type === 'unset' && patch.path.length === 3) {
      delete data.annotations[annotationKey]
      // If no more annotations, unwrap the inline
      if (Object.keys(data.annotations).length === 0) {
        return editor.unwrapInlineByKey(node.key)
      }
      return editor.setNodeByKey(node.key, {data})
    }
    const _patch = {...patch}
    _patch.path = patch.path.slice(2)
    const annotation = data.annotations[annotationKey]
    data.annotations[annotationKey] = applyAll([annotation], [_patch])[0]
    editor.setNodeByKey(node.key, {data})
    return editor.operations
  }

  function patchBlockData(patch: Patch, editor: SlateEditor) {
    const doc = editor.value.document
    const blockKey = patch.path[0]._key
    const block = doc.nodes.find(node => node.key === blockKey)
    // Only act on void formBuilder blocks
    if (editor.query('isVoid', block)) {
      const data = block.data.toObject()
      const _patch = {...patch}
      _patch.path = _patch.path.slice(1)
      const newValue = applyAll(data.value, [_patch])
      data.value = newValue
      editor.setNodeByKey(block.key, {data})
    }
    return editor.operations
  }

  function patchInlineData(patch: Patch, editor: SlateEditor, inline: SlateNode) {
    const data = inline.data.toObject()
    const _patch = {...patch}
    _patch.path = _patch.path.slice(3)
    const newValue = applyAll(data.value, [_patch])
    data.value = newValue
    editor.setNodeByKey(inline.key, {data})
    return editor.operations
  }

  function rebasePatch(patch: SetPatch, editor: SlateEditor) {
    if (
      !editor.value.selection.isFocused ||
      !Array.isArray(patch.value) ||
      patch.value.length === 0
    ) {
      return replaceValue(patch.value, editor)
    }
    // We must modify the selection' paths!
    const focusBlockKey = editor.value.focusBlock.key
    const anchorBlockKey = editor.value.anchorBlock.key
    const focusPath = editor.value.document.assertPath(focusBlockKey)
    const anchorPath = editor.value.document.assertPath(anchorBlockKey)
    const oldFocusBlockIndex = focusPath.get(0)
    const oldAnchorBlockIndex = anchorPath.get(0)
    const newFocusBlockIndex = patch.value.findIndex(blk => blk._key === focusBlockKey)
    const newAnchorBlockIndex = patch.value.findIndex(blk => blk._key === anchorBlockKey)
    if (newFocusBlockIndex !== oldFocusBlockIndex || newAnchorBlockIndex !== oldAnchorBlockIndex) {
      // console.log('Modifying selection and replacing value')
      const selection = editor.value.selection.toJSON()
      selection.anchor.path = [newAnchorBlockIndex, ...selection.anchor.path.slice(1)]
      selection.focus.path = [newFocusBlockIndex, ...selection.focus.path.slice(1)]
      replaceValue(patch.value, editor)
      editor.select(Selection.fromJSON(selection))
      return editor.operations
    }
    // console.log('Replacing value because rebase')
    return replaceValue(patch.value, editor)
  }

  function patchSpanText(
    patch: InsertPatch | SetPatch | DiffMatchPatch,
    editor: SlateEditor,
    node: SlateNode
  ) {
    const textPath = editor.value.document.assertPath(node.key)
    let newText

    if (patch.type === 'insert') {
      let nodeIndex = node.text.length
      if (patch.position === 'before') {
        nodeIndex--
      }
      patch.items.forEach(item => {
        const marks = Mark.createSet(
          item.marks.map(mrk => ({
            type: mrk
          }))
        )
        editor.insertTextByPath(textPath, nodeIndex++, item.text, marks)
      })
      return editor.operations
    }

    if (patch.type === 'set') {
      newText = Text.create({text: patch.value, marks: node.leaves.map(leaf => leaf.marks).get(0)})
      if (node.leaves.size === 1) {
        const marks = node.leaves.map(leaf => leaf.marks).get(0)
        editor.replaceNodeByPath(textPath, newText)
        marks.forEach(mark => {
          editor.setMarkByPath(textPath, 0, patch.value.length, mark)
        })
        return editor.operations
      }
      editor.insertTextByPath(
        textPath,
        node.text.length,
        patch.value.slice(node.leaves.last().text.length),
        node.leaves.map(leaf => leaf.marks).last()
      )
      return editor.operations
    }

    if (patch.type === 'diffMatchPatch') {
      newText = apply(node.text, {...patch, path: []})
      const marks = node.leaves.map(leaf => leaf.marks).last()
      editor.insertTextByPath(textPath, node.text.length, newText.slice(node.text.length), marks)
      return editor.operations
    }
    throw new Error(`Don't know how to handle ${patch.type} here`)
  }

  // eslint-disable-next-line complexity
  return function patchToOperations(patch: Patch, editorValue: SlateValue) {
    // console.log(JSON.stringify(patch, null, 2))
    controller.flush() // Must flush here or we end up with duplicate operations
    controller.setValue(editorValue, {normalize: false})

    if (patch.origin === 'internal' && patch.type === 'set' && isEqual(patch.path, [])) {
      return rebasePatch(patch, controller)
    }

    // Patches working on markDefs or inside blocks
    if (patch.path.length > 1) {
      if (patch.path[1] === 'markDefs') {
        return patchAnnotationData(patch, controller)
      } else if (patch.path[1] === 'children' && patch.path.length >= 3) {
        // Find the node (keys can be random on the working document)
        const node = findEditorChildNodeFromBlockChildKey(
          editorValue.document.getNode(patch.path[0]._key),
          findLastKey(patch.path)
        )
        if (!node) {
          throw new Error('Could not find childNode')
        }
        const isVoid = controller.query('isVoid', node)
        // eslint-disable-next-line max-depth
        if (isVoid) {
          return patchInlineData(patch, controller, node)
        }
        // eslint-disable-next-line max-depth
        if (patch.type === 'insert' || patch.type === 'set' || patch.type === 'diffMatchPatch') {
          return patchSpanText(patch, controller, node)
        }
      }
      return patchBlockData(patch, controller)
    }

    // Patches working on whole blocks or document
    switch (patch.type) {
      case 'set':
        return setPatch(patch, controller)
      case 'setIfMissing':
        return setIfMissingPatch(patch, controller)
      case 'insert':
        return insertPatch(patch, controller)
      case 'unset':
        return unsetPatch(patch, controller)
      default:
        throw new Error(`Don't know how to handle the patch ${patch.type}`)
    }
  }
}
