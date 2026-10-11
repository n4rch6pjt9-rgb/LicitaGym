-- Conferência dos dispositivos da Lei 14.133 com o texto do Planalto (06/10/2026).
--
-- Fonte oficial: https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm
-- (HTML em Windows-1252). O texto gravado foi comparado como trecho literal, depois de
-- colapsar espaços. 40 artigos conferem e passam a conferido_oficial. 22 não conferem
-- (o recorte gravado a partir de fonte secundária não é substring do artigo oficial) e
-- permanecem conferido_oficial = false: 53, 54, 55, 58, 60, 82, 86, 90, 92, 96, 97, 115,
-- 117, 124, 125, 131, 137, 156, 157, 158, 161, 165.
-- Inclui os arts. 11, 41 e 42, que o mapa sinal→dispositivo usa e que não estavam na base.
-- Não marca artigo divergente como conferido. Aditiva.

begin;

set local lock_timeout = '10s';

update public.norma_dispositivos
   set conferido_oficial = true,
       fonte_url = 'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm'
 where norma = 'LEI_14133_2021'
   and artigo = any (array[
     17, 56, 57, 59, 61, 62, 63, 64, 67, 69, 71, 83, 84, 89, 94, 98, 100, 104, 105, 106, 107,
     119, 120, 121, 123, 130, 134, 135, 138, 139, 140, 141, 143, 155, 160, 163, 164, 166, 167, 168
   ]);

insert into public.norma_dispositivos (norma, artigo, texto, recorte, fonte_url, conferido_oficial, observacao) values
(
  'LEI_14133_2021',
  11,
  $t$Art. 11. O processo licitatório tem por objetivos:

I - assegurar a seleção da proposta apta a gerar o resultado de contratação mais vantajoso para a Administração Pública, inclusive no que se refere ao ciclo de vida do objeto;

II - assegurar tratamento isonômico entre os licitantes, bem como a justa competição;

III - evitar contratações com sobrepreço ou com preços manifestamente inexequíveis e superfaturamento na execução dos contratos;

IV - incentivar a inovação e o desenvolvimento nacional sustentável.

Parágrafo único. A alta administração do órgão ou entidade é responsável pela governança das contratações e deve implementar processos e estruturas, inclusive de gestão de riscos e controles internos, para avaliar, direcionar e monitorar os processos licitatórios e os respectivos contratos, com o intuito de alcançar os objetivos estabelecidos no caput deste artigo, promover um ambiente íntegro e confiável, assegurar o alinhamento das contratações ao planejamento estratégico e às leis orçamentárias e promover eficiência, efetividade e eficácia em suas contratações.$t$,
  'caput, incisos I a IV e parágrafo único',
  'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm',
  true,
  'Conferido com o Planalto em 06/10/2026.'
),
(
  'LEI_14133_2021',
  41,
  $t$Art. 41. No caso de licitação que envolva o fornecimento de bens, a Administração poderá excepcionalmente:

I - indicar uma ou mais marcas ou modelos, desde que formalmente justificado, nas seguintes hipóteses:

a) em decorrência da necessidade de padronização do objeto;

b) em decorrência da necessidade de manter a compatibilidade com plataformas e padrões já adotados pela Administração;

c) quando determinada marca ou modelo comercializados por mais de um fornecedor forem os únicos capazes de atender às necessidades do contratante;

d) quando a descrição do objeto a ser licitado puder ser mais bem compreendida pela identificação de determinada marca ou determinado modelo aptos a servir apenas como referência;

II - exigir amostra ou prova de conceito do bem no procedimento de pré-qualificação permanente, na fase de julgamento das propostas ou de lances, ou no período de vigência do contrato ou da ata de registro de preços, desde que previsto no edital da licitação e justificada a necessidade de sua apresentação;

III - vedar a contratação de marca ou produto, quando, mediante processo administrativo, restar comprovado que produtos adquiridos e utilizados anteriormente pela Administração não atendem a requisitos indispensáveis ao pleno adimplemento da obrigação contratual;

IV - solicitar, motivadamente, carta de solidariedade emitida pelo fabricante, que assegure a execução do contrato, no caso de licitante revendedor ou distribuidor.

Parágrafo único. A exigência prevista no inciso II do caput deste artigo restringir-se-á ao licitante provisoriamente vencedor quando realizada na fase de julgamento das propostas ou de lances.$t$,
  'caput, incisos I a IV e parágrafo único',
  'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm',
  true,
  'Conferido com o Planalto em 06/10/2026.'
),
(
  'LEI_14133_2021',
  42,
  $t$Art. 42. A prova de qualidade de produto apresentado pelos proponentes como similar ao das marcas eventualmente indicadas no edital será admitida por qualquer um dos seguintes meios:

I - comprovação de que o produto está de acordo com as normas técnicas determinadas pelos órgãos oficiais competentes, pela Associação Brasileira de Normas Técnicas (ABNT) ou por outra entidade credenciada pelo Inmetro;

II - declaração de atendimento satisfatório emitida por outro órgão ou entidade de nível federativo equivalente ou superior que tenha adquirido o produto;

III - certificação, certificado, laudo laboratorial ou documento similar que possibilite a aferição da qualidade e da conformidade do produto ou do processo de fabricação, inclusive sob o aspecto ambiental, emitido por instituição oficial competente ou por entidade credenciada.

§ 1º O edital poderá exigir, como condição de aceitabilidade da proposta, certificação de qualidade do produto por instituição credenciada pelo Conselho Nacional de Metrologia, Normalização e Qualidade Industrial (Conmetro).

§ 2º A Administração poderá, nos termos do edital de licitação, oferecer protótipo do objeto pretendido e exigir, na fase de julgamento das propostas, amostras do licitante provisoriamente vencedor, para atender a diligência ou, após o julgamento, como condição para firmar contrato.

§ 3º No interesse da Administração, as amostras a que se refere o § 2º deste artigo poderão ser examinadas por instituição com reputação ético-profissional na especialidade do objeto, previamente indicada no edital.$t$,
  'caput, incisos I a III e §§ 1º a 3º',
  'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm',
  true,
  'Conferido com o Planalto em 06/10/2026.'
)
on conflict (norma, artigo) do update set
  texto = excluded.texto,
  recorte = excluded.recorte,
  fonte_url = excluded.fonte_url,
  conferido_oficial = true,
  observacao = excluded.observacao,
  atualizado_em = now();

commit;
