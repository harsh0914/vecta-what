export interface DocumentSnapshot<T = any> {
  id: string;
  exists: boolean;
  data(): T | undefined;
}

export interface QuerySnapshot<T = any> {
  docs: DocumentSnapshot<T>[];
  empty: boolean;
  size: number;
}

export interface DocumentRef<T = any> {
  id: string;
  collection: string;
  path: string;
  get(): Promise<DocumentSnapshot<T>>;
  set(data: Partial<T>, options?: { merge?: boolean }): Promise<void>;
  update(data: Partial<T>): Promise<void>;
  delete(): Promise<void>;
}

export interface Query<T = any> {
  where(field: string, op: '==' | '!=' | '<=' | '>=' | '<' | '>', value: any): Query<T>;
  orderBy(field: string, direction?: 'asc' | 'desc'): Query<T>;
  limit(limit: number): Query<T>;
  get(): Promise<QuerySnapshot<T>>;
  onSnapshot(
    callback: (snapshot: QuerySnapshot<T>) => void,
    onError?: (err: Error) => void
  ): () => void;
}

export interface Transaction {
  get<T = any>(ref: DocumentRef<T>): Promise<DocumentSnapshot<T>>;
  set<T = any>(ref: DocumentRef<T>, data: Partial<T>, options?: { merge?: boolean }): Transaction;
  update<T = any>(ref: DocumentRef<T>, data: Partial<T>): Transaction;
  delete(ref: DocumentRef): Transaction;
}

export interface Store {
  doc<T = any>(collection: string, id: string): DocumentRef<T>;
  collection<T = any>(name: string): Query<T>;
  runTransaction<R>(updateFunction: (transaction: Transaction) => Promise<R>): Promise<R>;
  getAll<T = any>(...docRefs: DocumentRef<T>[]): Promise<DocumentSnapshot<T>[]>;
}
