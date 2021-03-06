import {
  CreateManyDto,
  CrudRequest,
  CrudRequestOptions,
  CrudService,
  GetManyDefaultResponse,
  JoinOptions,
  QueryOptions,
} from '@nestjsx/crud';
import {
  ParsedRequestParams,
  QueryFields,
  QueryJoin,
  QuerySort,
} from '@nestjsx/crud-request';
import {
  hasLength,
  isArrayFull,
  isNil,
  isObject,
  isUndefined,
  objKeys,
} from '@nestjsx/util';
/**
 * mongoose imports
 */
import { Document, DocumentQuery, Model, Schema, Types } from 'mongoose';
import { DeepPartial, ObjectLiteral } from 'typeorm';

/**
 * Required so that ObjectIds are serialized correctly
 * See: http://thecodebarbarian.com/whats-new-in-mongoose-54-global-schematype-configuration.html#schematype-getters
 */
// tslint:disable-next-line:no-var-requires
const mongoose = require('mongoose');
mongoose.ObjectId.get((v) => (v ? v.toString() : null));

export class MongooseCrudService<T extends Document> extends CrudService<T> {
  private entityColumns: string[] = [];
  private entityPrimaryColumns: string[] = [];

  constructor(public repo: Model<T>) {
    super();

    this.onInitMapEntityColumns();
    this.onInitMapRelations();
  }

  public get findOne(): Model<T>['findOne'] {
    return this.repo.findOne.bind(this.repo);
  }

  public get find(): Model<T>['find'] {
    return this.repo.find.bind(this.repo);
  }

  public get findById(): Model<T>['findById'] {
    return this.repo.findById.bind(this.repo);
  }

  public get count(): Model<T>['count'] {
    return this.repo.countDocuments.bind(this.repo);
  }

  private get alias(): string {
    return this.repo.baseModelName;
  }

  /**
   * Get many
   * @param req
   */
  public async getMany(req: CrudRequest): Promise<GetManyDefaultResponse<T> | T[]> {
    const { parsed, options } = req;

    const { builder, take, skip } = await this.createBuilder<T[]>(
      this.find,
      parsed,
      options,
    );

    if (this.decidePagination(parsed, options)) {
      const data = await builder;
      const total = await this.count({});

      return this.createPageInfo(data, total, take, skip);
    }

    return builder;
  }

  /**
   * Get one
   * @param req
   */
  public async getOne(req: CrudRequest): Promise<T> {
    return this.getOneOrFail(req);
  }

  /**
   * Create one
   * @param req
   * @param dto
   */
  public async createOne(req: CrudRequest, dto: any): Promise<T> {
    const entity = this.prepareEntityBeforeSave(dto, req.parsed);

    /* istanbul ignore if */
    if (!entity) {
      this.throwBadRequestException(`Empty data. Nothing to save.`);
    }

    return this.repo.create(entity);
  }

  /**
   * Create many
   * @param req
   * @param dto
   */
  public async createMany(
    req: CrudRequest,
    dto: CreateManyDto<DeepPartial<T>>,
  ): Promise<T[]> {
    /* istanbul ignore if */
    if (!isObject(dto) || !isArrayFull(dto.bulk)) {
      this.throwBadRequestException(`Empty data. Nothing to save.`);
    }

    const bulk = dto.bulk
      .map((one) => this.prepareEntityBeforeSave(one, req.parsed))
      .filter((d) => !isUndefined(d));

    /* istanbul ignore if */
    if (!hasLength(bulk)) {
      this.throwBadRequestException(`Empty data. Nothing to save.`);
    }

    return ((await this.repo.create(bulk)) as unknown) as T[];
  }

  /**
   * Update one
   * @param req
   * @param dto
   */
  public async updateOne(req: CrudRequest, dto: any): Promise<T> {
    const { allowParamsOverride, returnShallow } = req.options.routes.updateOneBase;
    const paramsFilters = this.getParamFilters(req.parsed);
    const authPersist = req.parsed.authPersist || {};
    const toFind = { ...paramsFilters };

    const found = returnShallow
      ? await this.getOneShallowOrFail(toFind)
      : await this.getOneOrFail(req);

    const toSave = !allowParamsOverride
      ? { ...found.toObject(), ...dto, ...paramsFilters, ...authPersist }
      : { ...found.toObject(), ...dto, ...authPersist };

    const updated = await this.repo.findOneAndUpdate({ _id: found._id }, toSave, {
      new: true,
    });

    if (returnShallow) {
      return updated;
    } else {
      req.parsed.paramsFilter.forEach((filter) => {
        filter.value = updated[filter.field];
      });
      return this.getOneOrFail(req);
    }
  }

  /**
   * Replace one
   * @param req
   * @param dto
   */
  public async replaceOne(req: CrudRequest, dto: DeepPartial<T> | any): Promise<T> {
    const { allowParamsOverride, returnShallow } = req.options.routes.replaceOneBase;
    const paramsFilters = this.getParamFilters(req.parsed);
    const authPersist = req.parsed.authPersist || {};
    const toFind = { ...paramsFilters };

    const found = returnShallow
      ? await this.getOneShallowOrFail(toFind)
      : await this.getOneOrFail(req);

    const toSave = !allowParamsOverride
      ? { ...dto, ...paramsFilters, ...authPersist }
      : { ...paramsFilters, ...dto, ...authPersist };

    const replaced = await this.repo.replaceOne({ _id: found._id }, toSave);

    return this.findById(found._id);
  }

  /**
   * Delete one
   * @param req
   */
  public async deleteOne(req: CrudRequest): Promise<void | T> {
    const { returnDeleted } = req.options.routes.deleteOneBase;
    const paramsFilters = this.getParamFilters(req.parsed);
    const toFind = { ...paramsFilters };

    const found = await this.getOneShallowOrFail(toFind);
    const deleted = await this.repo.findOneAndDelete({ _id: found._id });

    /* istanbul ignore next */
    return returnDeleted ? { ...deleted, ...paramsFilters } : undefined;
  }

  public getParamFilters(parsed: CrudRequest['parsed']): ObjectLiteral {
    const filters = {};

    /* istanbul ignore else */
    if (hasLength(parsed.paramsFilter)) {
      for (const filter of parsed.paramsFilter) {
        filters[filter.field] = filter.value;
      }
    }

    return filters;
  }

  public decidePagination(
    parsed: ParsedRequestParams,
    options: CrudRequestOptions,
  ): boolean {
    return (
      (Number.isFinite(parsed.page) || Number.isFinite(parsed.offset)) &&
      !!this.getTake(parsed, options.query)
    );
  }

  /**
   * Create TypeOrm QueryBuilder
   * @param fn
   * @param parsed
   * @param options
   * @param many
   */
  public async createBuilder<K>(
    fn: (...args) => DocumentQuery<K, T>,
    parsed: ParsedRequestParams,
    options: CrudRequestOptions,
    many = true,
  ): Promise<{ builder: DocumentQuery<K, T>; take?: number; skip?: number }> {
    // get select fields
    const select = this.getSelect(parsed, options.query);
    // default search condition
    const defaultSearch = this.getDefaultSearchCondition(options, parsed);

    const builder = fn(defaultSearch);
    // select fields
    builder.select(select);

    // set joins
    const joinOptions = options.query.join || {};
    const allowedJoins = objKeys(joinOptions);

    if (hasLength(allowedJoins)) {
      const eagerJoins: { [key: string]: boolean } = {};

      for (let i = 0; i < allowedJoins.length; i++) {
        /* istanbul ignore else */
        if (joinOptions[allowedJoins[i]].eager) {
          const cond = parsed.join.find((j) => j && j.field === allowedJoins[i]) || {
            field: allowedJoins[i],
          };
          this.setJoin(cond, joinOptions, builder);
          builder.populate(cond.field, cond.select.join(' '));
          eagerJoins[allowedJoins[i]] = true;
        }
      }

      if (isArrayFull(parsed.join)) {
        for (let i = 0; i < parsed.join.length; i++) {
          /* istanbul ignore else */
          if (!eagerJoins[parsed.join[i].field]) {
            this.setJoin(parsed.join[i], joinOptions, builder);
          }
        }
      }
    }

    /* istanbul ignore else */
    if (many) {
      // set sort (order by)
      const sort = this.getSort(parsed, options.query);
      builder.sort(sort);

      // set take
      const take = this.getTake(parsed, options.query);
      /* istanbul ignore else */
      if (isFinite(take)) {
        builder.limit(take);
      }

      // set skip
      const skip = this.getSkip(parsed, take);
      /* istanbul ignore else */
      if (isFinite(skip)) {
        builder.skip(skip);
      }

      return { builder, take, skip };
    }

    return { builder };
  }

  buildFieldSelect(include: QueryFields, excludes: QueryFields): string {
    return (include || [])
      .filter((field) => !(excludes || []).includes(field))
      .concat(...(excludes || []).map((e) => `-${e}`))
      .join(' ');
  }

  buildNestedVirtualPopulate<K>(field: string, select: string): any {
    const fields = field.split('.');
    const populates = [];

    let lastSchema: Schema = this.repo.schema;

    for (let i = 0; i < fields.length; ++i) {
      const virtual: any = lastSchema.virtualpath(fields[i]);

      if (virtual) {
        lastSchema = mongoose.model(virtual.options.ref).schema;
        populates.push({
          path: fields[i],
        });
      } else {
        this.throwBadRequestException(`${fields[i]} is not a valid join.`);
      }
    }

    return populates.reverse().reduce(
      (populate, cur, index: number) => ({
        ...cur,
        ...(index === 0 ? { select } : { populate }),
      }),
      {},
    );
  }

  protected setJoin<K>(
    cond: QueryJoin,
    joinOptions: JoinOptions,
    builder: DocumentQuery<K, T>,
  ) {
    const joinOption = joinOptions[cond.field];
    let excludes = isNil(joinOption) ? [] : joinOption.exclude;

    if (isNil(excludes)) {
      excludes = [];
    }

    const select = this.buildFieldSelect(cond.select, excludes);

    const populate = this.buildNestedVirtualPopulate(cond.field, select);

    return builder.populate(populate);
  }

  protected async getOneOrFail(req: CrudRequest): Promise<T> {
    const { parsed, options } = req;
    // TODO: bad request if _id does not match ObjectId
    const { builder } = await this.createBuilder(this.findOne, parsed, options);
    const found = await builder;

    if (!found) {
      this.throwNotFoundException(this.alias);
    }

    return found;
  }

  protected async getOneShallowOrFail(where: ObjectLiteral): Promise<T> {
    if (where._id) {
      where._id = Types.ObjectId(where._id);
    }
    const found = await this.findOne(where);

    if (!found) {
      this.throwNotFoundException(this.alias);
    }

    return found;
  }

  protected prepareEntityBeforeSave(
    dto: DeepPartial<T>,
    parsed: CrudRequest['parsed'],
  ): DeepPartial<T> {
    /* istanbul ignore if */
    if (!isObject(dto)) {
      return undefined;
    }

    if (hasLength(parsed.paramsFilter)) {
      for (const filter of parsed.paramsFilter) {
        dto[filter.field] = filter.value;
      }
    }

    const authPersist = isObject(parsed.authPersist) ? parsed.authPersist : {};

    /* istanbul ignore if */
    if (!hasLength(objKeys(dto))) {
      return undefined;
    }

    return { ...dto, ...authPersist };
  }

  private getDefaultSearchCondition(
    options: CrudRequestOptions,
    parsed: ParsedRequestParams,
  ): any {
    const filter = this.queryFilterToSearch(options.query.filter);
    const paramsFilter = this.queryFilterToSearch(parsed.paramsFilter);

    return { ...filter, ...paramsFilter };
  }

  private queryFilterToSearch(filter: any): any {
    return isArrayFull(filter)
      ? filter.reduce(
          (prev, item) => ({
            ...prev,
            [item.field]: { [item.operator]: item.value },
          }),
          {},
        )
      : isObject(filter)
      ? filter
      : {};
  }

  private onInitMapEntityColumns() {
    this.repo.schema.eachPath((path) => {
      this.entityColumns.push(path);
    });
  }

  private onInitMapRelations() {
    // this.entityRelationsHash = this.repo.metadata.relations.reduce(
    //   (hash, curr) => ({
    //     ...hash,
    //     [curr.propertyName]: {
    //       name: curr.propertyName,
    //       columns: curr.inverseEntityMetadata.columns.map((col) => col.propertyName),
    //       primaryColumns: curr.inverseEntityMetadata.primaryColumns.map(
    //         (col) => col.propertyName,
    //       ),
    //     },
    //   }),
    //   {},
    // );
  }

  private getAllowedColumns(columns: string[], options: QueryOptions): string[] {
    return (!options.exclude || !options.exclude.length) &&
      (!options.allow || /* istanbul ignore next */ !options.allow.length)
      ? columns
      : columns.filter(
          (column) =>
            (options.exclude && options.exclude.length
              ? !options.exclude.some((col) => col === column)
              : /* istanbul ignore next */ true) &&
            (options.allow && options.allow.length
              ? options.allow.some((col) => col === column)
              : /* istanbul ignore next */ true),
        );
  }

  private getSelect(query: ParsedRequestParams, options: QueryOptions): string {
    const allowed = this.getAllowedColumns(this.entityColumns, options);

    const columns =
      query.fields && query.fields.length
        ? query.fields.filter((field) => allowed.some((col) => field === col))
        : allowed;

    const select = [
      ...(options.persist && options.persist.length ? options.persist : []),
      ...columns,
      ...this.entityPrimaryColumns,
    ]
      .map((col) => `${col}`)
      .join(' ');

    return select;
  }

  private getSort(query: ParsedRequestParams, options: QueryOptions) {
    return query.sort && query.sort.length
      ? this.mapSort(query.sort)
      : options.sort && options.sort.length
      ? this.mapSort(options.sort)
      : {};
  }

  private mapSort(sort: QuerySort[]) {
    const params: ObjectLiteral = {};

    for (let i = 0; i < sort.length; i++) {
      params[sort[i].field] = sort[i].order.toLowerCase();
    }

    return params;
  }
}
