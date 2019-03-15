import * as fs from 'fs-extra'
import * as inflection from 'inflection'
import * as path from 'path'
import { FunctionDeclarationOverloadStructure, Project, PropertySignatureStructure } from 'ts-morph'
import { ContentTypeWriter } from './content-type-writer'

export interface GeneratorOptions {
  schemaFile: string
  outputDir: string
}

export class ContentfulTSGenerator {
  private readonly options: Readonly<GeneratorOptions>

  constructor(options?: Partial<GeneratorOptions>) {
    const opts = Object.assign({

    }, options)

    if (!opts.schemaFile) {
      if (fs.statSync('db').isDirectory()) {
        opts.schemaFile = 'db/contentful-schema.json'
      } else {
        opts.schemaFile = 'contentful-schema.json'
      }
    }

    if (!opts.outputDir) {
      if (fs.statSync('app/assets/javascripts')) {
        opts.outputDir = 'app/assets/javascripts/lib/contentful'
      } else {
        opts.outputDir = 'lib/contentful'
      }
    }

    this.options = opts as GeneratorOptions
  }

  public generate = async () => {
    const options = this.options
    const indexFileName = path.join(path.resolve(options.outputDir), 'index.ts')

    const schema = JSON.parse(await fs.readFile(options.schemaFile).toString())

    await fs.mkdirp(options.outputDir)
    if (await fs.pathExists(indexFileName)) {
      await fs.truncate(indexFileName)
    }

    const project = new Project()
    const indexFile = project.addExistingSourceFileIfExists(indexFileName) || project.createSourceFile(indexFileName)

    const typeDirectory = {} as { [id: string]: string }
    const fieldsDirectory = {} as { [id: string]: string }
    const classDirectory = {} as { [id: string]: string }
    await Promise.all(schema.contentTypes.map(async (ct: any) => {
      const fileName = idToFilename(ct.sys.id)

      const fullPath = path.join(path.resolve(options.outputDir), fileName + '.ts')
      const file = project.createSourceFile(fullPath)
      const writer = new ContentTypeWriter(ct, file)
      await writer.write()

      // export * from './${fileName}
      indexFile.addExportDeclaration({
        moduleSpecifier: `./${fileName}`,
      })

      typeDirectory[ct.sys.id] = writer.interfaceName
      fieldsDirectory[ct.sys.id] = writer.fieldsName
      classDirectory[ct.sys.id] = writer.className
    }))

    // import * as C from '.'
    indexFile.addImportDeclaration({
      namespaceImport: 'C',
      moduleSpecifier: '.',
    })
    // import { IEntry } from '../base'
    indexFile.addImportDeclaration({
      namedImports: ['IEntry'],
      moduleSpecifier: '../base',
    })

    indexFile.addInterface({
      name: 'TypeDirectory',
      isExported: true,
      properties: Object.keys(typeDirectory).map<PropertySignatureStructure>((ct: any) => (
        {
          name: ct,
          type: `C.${typeDirectory[ct]}`,
        }
      )),
    })

    indexFile.addInterface({
      name: 'ClassDirectory',
      isExported: true,
      properties: Object.keys(classDirectory).map<PropertySignatureStructure>((ct: any) => (
        {
          name: ct,
          type: `C.${classDirectory[ct]}`,
        }
      )),
    })

    const wrapOverloads = Object.keys(classDirectory)
      .map<FunctionDeclarationOverloadStructure>((ct) => ({
        parameters: [{
          name: 'entry',
          type: `C.${typeDirectory[ct]}`,
        }],
        returnType: `C.${classDirectory[ct]}`,
      }))

    // wrap<CT extends keyof TypeDirectory>(entry: TypeDirectory[CT]): ClassDirectory[CT]
    wrapOverloads.push({
      typeParameters: [{
        name: 'CT',
        constraint: 'keyof TypeDirectory',
      }],
      parameters: [{
        name: 'entry',
        type: 'TypeDirectory[CT]',
      }],
      returnType: 'ClassDirectory[CT]',
    })

    // export function wrap(entry: IEntry<any>): IEntry<any>
    const wrapFn = indexFile.addFunction({
      name: 'wrap',
      parameters: [{
        name: 'entry',
        type: 'IEntry<any>',
      }],
      returnType: 'IEntry<any>',
      overloads: wrapOverloads,
    })

    wrapFn.setBodyText((writer) => {
      writer.writeLine('const id = entry.sys.contentType.sys.id')
        .writeLine('switch(id) {')

      Object.keys(classDirectory).map((ct) => {
        writer.writeLine(`case '${ct}':`)
          .writeLine(`return new C.${classDirectory[ct]}(entry)`)
      })
      writer.writeLine('default:')
      writer.writeLine('throw new Error(\'Unknown content type:\' + id)')
      writer.writeLine('}')
    })

    await indexFile.save()
  }
}

function idToFilename(id: string) {
  return inflection.underscore(id, false)
}
