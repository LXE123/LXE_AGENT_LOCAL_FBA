import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from saihu_msku_compare import pages, quantity, keyed, redact, Client
from analyze_saihu_msku_compare import sales_rows


class FakeClient:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def post(self, provider, endpoint, body):
        self.calls.append(body)
        return {'data':next(self.responses)}


def page(number, rows, total=3, size=2):
    return dict(pageNo=number,pageSize=size,totalSize=total,totalPage=(total+size-1)//size,rows=rows)


def row(sku):
    return dict(sku=sku,shopId='shop',marketplaceId='US')


def test_complete_pagination_and_scope():
    client = FakeClient([page(1,[row('a'),row('b')]),page(2,[row('c')])])
    assert len(pages(client,'online-products/v2',{},shop='shop',marketplace='US')) == 3
    assert [x['pageNo'] for x in client.calls] == ['1','2']


@pytest.mark.parametrize('bad', [dict(row('a'),shopId='other'),dict(row('a'),marketplaceId='CA'),{'sku':'a'}])
def test_scope_rejects_missing_or_cross_shop(bad):
    with pytest.raises(ValueError,match='cross-'):
        pages(FakeClient([page(1,[bad],total=1)]),'online-products/v2',{},shop='shop',marketplace='US')


def test_analysis_array_scope():
    r = dict(shopIdList=['shop'],marketplaceIdList=['US'])
    assert pages(FakeClient([page(1,[r],total=1)]),'product-analysis/v2',{},shop='shop',marketplace='US') == [r]
    with pytest.raises(ValueError,match='cross-shop'):
        pages(FakeClient([page(1,[dict(r,shopIdList=['shop','other'])],total=1)]),'product-analysis/v2',{},shop='shop')


def test_repeated_pages_and_changed_totals():
    with pytest.raises(ValueError,match='repeated page'):
        pages(FakeClient([page(1,[row('a')],total=2,size=1),page(2,[row('a')],total=2,size=1)]),'test',{})
    with pytest.raises(ValueError,match='totals changed'):
        pages(FakeClient([page(1,[row('a'),row('b')]),page(2,[row('c'),row('d')],total=4)]),'test',{})


def test_empty_and_truncated_page():
    assert pages(FakeClient([page(1,[],total=0)]),'test',{}) == []
    with pytest.raises(ValueError,match='row count'):
        pages(FakeClient([page(1,[row('a')])]),'test',{})


@pytest.mark.parametrize('v',[None,''])
def test_missing_is_not_zero(v):
    assert quantity(v) is None
    assert quantity('0') == 0


@pytest.mark.parametrize('v',['NaN','Infinity',-1,True])
def test_invalid_quantities(v):
    with pytest.raises(ValueError): quantity(v)


def test_duplicate_conflicts():
    a=dict(msku='a',asin='b',local_sku='one')
    _,conflicts,duplicates=keyed([a,a,dict(a,local_sku='two')],['msku','asin'])
    assert duplicates == 1
    assert len(conflicts[('a','b')]) == 2


def test_sales_nested_contract_and_ambiguous_binding():
    r=dict(mskuList=['a'],asinList=['b'],productIdList=['1'],fieldsMap={'sevenSaleNum':{'currValue':'4'}})
    rows,rejected=sales_rows([r,dict(r,asinList=['b','c'])])
    assert rows[0]['7天销量'] == 4
    assert rows[0]['14天销量'] is None
    assert len(rejected) == 1


def test_errors_preserve_diagnostics_and_redact():
    value={'detail':{'upstream':{'code':40014,'msg':'date required','token':'abc'}},'text':'Bearer abc'}
    result=redact(value,['abc'])
    assert result['detail']['upstream']['msg'] == 'date required'
    assert 'abc' not in str(result)
    assert Client.business_failure(value,'0')
    assert not Client.business_failure({'detail':'gateway unavailable'},'0')


def test_http_auth_retry_and_saved_error(tmp_path, monkeypatch):
    import saihu_msku_compare as module
    monkeypatch.setenv('LXE_DATA_SERVER_URL','http://unit.test')
    monkeypatch.delenv('LXE_DATA_SERVER_PRIVATE_URL',raising=False)
    monkeypatch.setenv('LXE_DATA_SERVER_API_KEY','unit-secret')
    client=Client(tmp_path)
    assert client.session.trust_env is False
    calls=[]
    class Response:
        headers={'Retry-After':'2'}
        def __init__(self,status,body): self.status_code,self.body=status,body
        def json(self): return self.body
    responses=iter([Response(429,{'code':40019,'msg':'rate limited'}),Response(200,{'code':0,'data':{}})])
    def post(url,**kwargs):
        calls.append(kwargs)
        return next(responses)
    monkeypatch.setattr(client.session,'post',post)
    waits=[]
    monkeypatch.setattr(module.time,'sleep',waits.append)
    assert client.post('saihu','test',{})['code']==0
    assert waits==[2]
    assert calls[0]['headers']=={'Authorization':'Bearer unit-secret'}
    assert calls[0]['timeout']==60
    assert 'unit-secret' not in (tmp_path/'requests.json').read_text()
    monkeypatch.setattr(client.session,'post',lambda *a,**k:Response(502,{'detail':{'upstream':{'code':40014,'msg':'required unit-secret'}}}))
    with pytest.raises(RuntimeError,match='40014') as exc:
        client.post('saihu','test',{})
    assert 'unit-secret' not in str(exc.value)
    assert waits==[2]


def test_replay_uses_fixed_inputs_and_changes_only_sales():
    from analyze_saihu_msku_compare import replay
    from decimal import Decimal
    source={'MSKU':'one','ASIN':'ASIN','父ASIN':'parent','本地SKU':'stock','商品链接':'https://www.amazon.com/dp/ASIN','7天销量':14,'14天销量':28,'30天销量':60,'可售':5,'待入库':0,'预留':0,'在途':0,'待调仓':0,'调仓中':0,'单品重量(g)(cm)':100}
    binding={'local_sku':'stock'}
    metrics={'7天销量':28,'14天销量':56,'30天销量':120}
    inputs=[(source,binding,metrics)]
    a,actual_a,_=replay(inputs,{}, {'stock':Decimal(200)},'mabang',{'one':3})
    b,actual_b,_=replay(inputs,{}, {'stock':Decimal(200)},'saihu',{'one':3})
    assert a[0]['actual_inventory']==b[0]['actual_inventory']==200
    assert a[0]['fba_total_inventory']==b[0]['fba_total_inventory']==5
    assert a[0]['unlinked_quantity']==b[0]['unlinked_quantity']==3
    assert a[0]['weighted_daily_sales']*2==b[0]['weighted_daily_sales']
    assert replay(inputs,{}, {'stock':Decimal(200)},'saihu',{'one':3})[0]==b
